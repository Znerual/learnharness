/**
 * Plugin data sync, the app side (ADR 0007; vault ADR 0014). It gives the sync engine the plugin
 * files of every active plugin (PluginFilesHost), stops a plugin's backend while the engine writes
 * its files, and tells the engine when plugins are enabled, disabled, uninstalled or used.
 *
 * Loaded with the vault client (runtime.ts); plugins.ts reaches it only through ./active.ts.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { type ActivePlugin, DEFAULT_LIMITS, isSyncablePluginPath, type PluginFileIO, type PluginFilesHost, type PluginFileStat, type PluginRef, type SyncEngine } from "@znerual/learnharness-vault-client";

import { isSyncExcluded, type PluginInfo } from "../../core/plugins.ts";
import type { CorePluginDataLocation } from "../../store/plugin-data-paths.ts";
import { safePluginDataDirectory } from "../../store/plugin-data-paths.ts";
import type { PluginSyncDto, PluginSyncHooks } from "./active.ts";

/** The plugin host operations this module uses (src/server/plugin-host.ts). */
export interface PluginHostLike {
	list(): PluginInfo[];
	withStopped(id: string, fn: () => Promise<void>, o?: { isBusy?: () => boolean; waitMs?: number }): Promise<boolean | "busy">;
}

export interface PluginSyncDeps {
	getHost(): Promise<PluginHostLike>;
	/** Community plugin packages (PLUGINS_DIR, device-local). */
	pluginDirectory: string;
	core: CorePluginDataLocation;
	/** PATHS.local */
	localDir: string;
	engine(): SyncEngine | null;
	/** Live worker tasks of a plugin (plugin-worker-activity.ts). */
	hasLiveWork(id: string): boolean;
	/** Plugin views refetch after their files changed (src/core/events.ts `plugin-message`). */
	notify(id: string): void;
	now?: () => Date;
}

interface OptIns {
	version: 1;
	community: Record<string, boolean>;
}

const TOUCH_DELAY_MS = 5_000;
const ACTIVATION_TIMEOUT_MS = 20_000;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const utf8 = new TextDecoder("utf-8", { fatal: true });

const refOf = (info: PluginInfo): PluginRef => ({ origin: info.origin, id: info.id });

/** Throws unless the bytes are what their extension says (JSON parses, text is UTF-8, images have their signature). */
export function checkPluginFileContent(rel: string, data: Uint8Array): void {
	const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "png") {
		if (!PNG.every((b, i) => data[i] === b)) throw new Error(`${rel} is not a PNG image`);
		return;
	}
	if (ext === "webp") {
		const tag = (o: number) => String.fromCharCode(...data.subarray(o, o + 4));
		if (data.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") throw new Error(`${rel} is not a WebP image`);
		return;
	}
	const text = utf8.decode(data);
	if (ext === "json") JSON.parse(text);
	if (ext === "jsonl") for (const line of text.split("\n")) if (line.trim()) JSON.parse(line);
}

export function createPluginSync(deps: PluginSyncDeps) {
	const optInFile = join(deps.localDir, "vault", "plugin-sync.json");
	const activating = new Set<string>();
	const touchTimers = new Map<string, NodeJS.Timeout>();
	let knownCommunity = new Set<string>();

	function readOptIns(): OptIns {
		try {
			const v = JSON.parse(readFileSync(optInFile, "utf8")) as OptIns;
			if (v?.version === 1 && v.community && typeof v.community === "object") return v;
		} catch {
			// none yet
		}
		return { version: 1, community: {} };
	}

	function writeOptIns(v: OptIns): void {
		mkdirSync(dirname(optInFile), { recursive: true });
		const temp = `${optInFile}.${randomUUID()}.tmp`;
		writeFileSync(temp, JSON.stringify(v), { mode: 0o600 });
		renameSync(temp, optInFile);
	}

	function dataDir(p: PluginRef, create = false): string | null {
		return safePluginDataDirectory(deps.pluginDirectory, p.id, p.origin === "core" ? deps.core : undefined, create);
	}

	function syncOn(info: PluginInfo): boolean {
		return info.origin === "core" || readOptIns().community[info.id] === true;
	}

	function asActive(info: PluginInfo): ActivePlugin {
		return {
			origin: info.origin, id: info.id,
			identity: { name: info.manifest?.name ?? info.id, source: info.origin === "core" ? "core" : (info.manifest?.author ?? "community") },
			limits: DEFAULT_LIMITS[info.origin],
		};
	}

	async function infoOf(id: string): Promise<PluginInfo | undefined> {
		return (await deps.getHost()).list().find((p) => p.id === id);
	}

	/** Resolves a data-folder path, refusing anything outside it or through a symlink. */
	function resolveIn(root: string, rel: string, createDirs: boolean): string {
		if (!isSyncablePluginPath(rel)) throw new Error(`not a syncable plugin file: ${rel}`);
		const realRoot = realpathSync(root);
		let current = root;
		const parts = rel.split("/");
		for (let i = 0; i < parts.length - 1; i++) {
			current = join(current, parts[i] as string);
			try {
				const st = lstatSync(current);
				if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe plugin data path: ${rel}`);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !createDirs) throw e;
				mkdirSync(current, { mode: 0o700 });
			}
		}
		const file = join(current, parts[parts.length - 1] as string);
		const r = relative(realRoot, realpathSync(dirname(file)));
		if (r === ".." || r.startsWith(`..${sep}`)) throw new Error(`plugin data path escapes its folder: ${rel}`);
		try {
			const st = lstatSync(file);
			if (!st.isFile()) throw new Error(`not a regular file: ${rel}`);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		return file;
	}

	function writeSafely(root: string, rel: string, data: Uint8Array): void {
		checkPluginFileContent(rel, data);
		const file = resolveIn(root, rel, true);
		const temp = join(dirname(file), `.${randomUUID()}.sync.tmp`);
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			renameSync(temp, file);
		} catch (e) {
			try {
				unlinkSync(temp);
			} catch {
				// already gone
			}
			throw e;
		}
	}

	const filesHost: PluginFilesHost = {
		async activePlugins() {
			const host = await deps.getHost();
			return host.list().filter((p) => p.manifest && (p.enabled || activating.has(p.id)) && syncOn(p)).map(asActive);
		},

		async listPluginFiles(p) {
			const root = dataDir(p);
			if (!root) return [];
			const exclude = (await infoOf(p.id))?.manifest?.sync?.exclude;
			const out: PluginFileStat[] = [];
			const walk = (dir: string, prefix: string, depth: number) => {
				let names: string[];
				try {
					names = readdirSync(dir);
				} catch {
					return;
				}
				for (const name of names.sort()) {
					if (name.startsWith(".") || name.endsWith(".tmp")) continue;
					const rel = prefix ? `${prefix}/${name}` : name;
					if (isSyncExcluded(rel, exclude) || isSyncExcluded(`${rel}/`, exclude)) continue;
					const full = join(dir, name);
					const st = lstatSync(full);
					if (st.isSymbolicLink()) continue;
					if (st.isDirectory()) {
						if (depth < 2) walk(full, rel, depth + 1);
					} else if (st.isFile() && isSyncablePluginPath(rel)) out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
				}
			};
			walk(root, "", 0);
			return out;
		},

		async readPluginFile(p, rel) {
			const root = dataDir(p);
			if (!root) return null;
			try {
				return new Uint8Array(readFileSync(resolveIn(root, rel, false)));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw e;
			}
		},

		pluginBusy(p) {
			return deps.hasLiveWork(p.id);
		},

		async withPluginStopped(p, fn) {
			const host = await deps.getHost();
			const result = await host.withStopped(
				p.id,
				async () => {
					const root = dataDir(p, true) as string;
					const io: PluginFileIO = {
						read: (rel) => filesHost.readPluginFile(p, rel),
						write: async (rel, data) => writeSafely(root, rel, data),
						remove: async (rel) => rmSync(resolveIn(root, rel, false), { force: true }),
					};
					await fn(io);
				},
				{ isBusy: () => deps.hasLiveWork(p.id) },
			);
			if (result !== "busy") deps.notify(p.id);
			return result;
		},

		async acceptsPluginFile(p, rel) {
			// The same rule as listPluginFiles: what this device would not send, it does not take.
			const exclude = (await infoOf(p.id))?.manifest?.sync?.exclude;
			if (rel.split("/").some((name) => name.startsWith(".") || name.endsWith(".tmp"))) return false;
			const parts = rel.split("/");
			for (let i = 1; i < parts.length; i++) if (isSyncExcluded(`${parts.slice(0, i).join("/")}/`, exclude) || isSyncExcluded(parts.slice(0, i).join("/"), exclude)) return false;
			return !isSyncExcluded(rel, exclude);
		},

		async writePluginConflict(p, rel, data) {
			const d = (deps.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
			const file = join(deps.localDir, "conflicts", "plugins", p.origin, p.id, `${rel}.${d}`);
			mkdirSync(dirname(file), { recursive: true });
			let target = file;
			for (let i = 1; ; i++) {
				try {
					lstatSync(target);
					target = `${file}-${i}`;
				} catch {
					break;
				}
			}
			writeFileSync(target, data, { mode: 0o600 });
		},
	};

	function touched(id: string): void {
		const engine = deps.engine();
		if (!engine) return;
		clearTimeout(touchTimers.get(id));
		touchTimers.set(id, setTimeout(() => {
			touchTimers.delete(id);
			void engine.sync().catch(() => undefined);
		}, TOUCH_DELAY_MS));
	}

	async function activate(info: PluginInfo): Promise<void> {
		const engine = deps.engine();
		if (!engine || !syncOn(info)) return;
		activating.add(info.id);
		try {
			await Promise.race([
				engine.activatePlugin(refOf(info)),
				new Promise((resolve) => setTimeout(resolve, ACTIVATION_TIMEOUT_MS)),
			]);
		} catch {
			// Offline or the vault refused: the plugin starts with its local data and catches up later.
		} finally {
			activating.delete(info.id);
		}
	}

	/** Removes a community plugin's synced data on this device; the vault keeps its copy. */
	async function removeLocalData(info: PluginInfo): Promise<void> {
		const host = await deps.getHost();
		const p = refOf(info);
		await host.withStopped(info.id, async () => {
			const root = dataDir(p);
			if (root) for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
			rmSync(join(deps.localDir, "plugin-local", info.id), { recursive: true, force: true });
		});
		await deps.engine()?.forgetPlugin(p);
	}

	const hooks: PluginSyncHooks = {
		async beforeEnable(id) {
			const info = await infoOf(id);
			if (info?.manifest) await activate(info);
		},
		afterDisable(id) {
			const info = { origin: knownCommunity.has(id) ? "community" : "core", id } as PluginRef;
			deps.engine()?.deactivatePlugin(info);
		},
		touched,
		async afterRefresh() {
			// A community plugin whose package disappeared was uninstalled: forget its sync state.
			// Its data folder went with the package; the vault keeps the data for a reinstall.
			const now = new Set((await deps.getHost()).list().filter((p) => p.origin === "community").map((p) => p.id));
			for (const id of knownCommunity) {
				if (now.has(id)) continue;
				rmSync(join(deps.localDir, "plugin-local", id), { recursive: true, force: true });
				await deps.engine()?.forgetPlugin({ origin: "community", id });
			}
			knownCommunity = now;
			deps.engine()?.pluginsChanged();
		},
		async list(): Promise<PluginSyncDto> {
			const engine = deps.engine();
			const status = engine?.pluginStatus();
			const registry = engine ? await engine.pluginRegistry() : [];
			const opt = readOptIns().community;
			const plugins = (await deps.getHost()).list().filter((p) => p.manifest).map((p) => {
				const reg = registry.find((r) => r.origin === p.origin && r.id === p.id);
				return {
					id: p.id, origin: p.origin, name: p.manifest?.name ?? p.id, enabled: p.enabled,
					sync: p.origin === "core" ? true : opt[p.id] === true,
					inVault: !!reg,
					identityMismatch: p.origin === "community" && !!reg && (reg.name !== (p.manifest?.name ?? p.id) || reg.source !== (p.manifest?.author ?? "community")),
					...(status?.overLimit[`${p.origin}/${p.id}`] ? { overLimit: status.overLimit[`${p.origin}/${p.id}`] } : {}),
				};
			});
			for (const r of registry) {
				if (plugins.some((p) => p.origin === r.origin && p.id === r.id)) continue;
				plugins.push({ id: r.id, origin: r.origin, name: r.name, enabled: false, sync: false, inVault: true, identityMismatch: false });
			}
			let outdatedDevices: string[] = [];
			try {
				const devices = (await engine?.devices()) ?? [];
				outdatedDevices = devices.filter((d) => !d.current && !(d.capabilities ?? []).includes("chains-1")).map((d) => d.name);
			} catch {
				// offline
			}
			return { plugins, conflicts: status?.conflicts ?? 0, outdatedDevices };
		},
		async setCommunitySync(id, enabled, confirmIdentity) {
			const info = await infoOf(id);
			if (!info?.manifest || info.origin !== "community") throw new Error("not a community plugin");
			const opt = readOptIns();
			if (enabled) {
				const dto = await hooks.list();
				if (dto.plugins.find((p) => p.id === id)?.identityMismatch && !confirmIdentity) {
					throw Object.assign(new Error("The plugin installed here differs from the one whose data is in the vault"), { code: "identity_mismatch" });
				}
				opt.community[id] = true;
				writeOptIns(opt);
				deps.engine()?.pluginsChanged();
				if (info.enabled) await activate(info);
			} else {
				delete opt.community[id];
				writeOptIns(opt);
				await removeLocalData(info);
				deps.engine()?.pluginsChanged();
			}
		},
		async deleteSyncedData(origin, id, grant) {
			const engine = deps.engine();
			if (!engine) throw new Error("the vault is not syncing");
			if (!(await engine.pluginRegistry()).some((r) => r.origin === origin && r.id === id)) throw Object.assign(new Error("The vault holds no data of this plugin"), { code: "not_found" });
			if ((await filesHost.activePlugins()).some((p) => p.origin === origin && p.id === id)) {
				throw Object.assign(new Error("This device still syncs the plugin: disable it or turn its sync off first"), { code: "plugin_active" });
			}
			await engine.deletePluginData({ origin, id }, grant);
		},
	};

	return {
		filesHost,
		hooks,
		/** Remembers the installed community plugins, to notice uninstalls on the next refresh. */
		async start(): Promise<void> {
			knownCommunity = new Set((await deps.getHost()).list().filter((p) => p.origin === "community").map((p) => p.id));
		},
		stop(): void {
			for (const t of touchTimers.values()) clearTimeout(t);
			touchTimers.clear();
		},
	};
}
