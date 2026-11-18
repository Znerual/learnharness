// Delta chains for plugin files (vault ADR 0014, LearnHarness ADR 0007).
//
// Every synced plugin file is a chain of create-only slot records, pf/<origin>/<id>/<rel>/<slot>:
// a full slot holds the file, a delta slot the changes against the previous slot. A plugin index
// chain (pi/<origin>/<id>/<slot>) lists each plugin's files, and the registry chain (pr/<slot>)
// lists the plugins. Plugin files are compared with the last synced version (the shadow): the
// files are the source of truth, so there is no outbox for them and a crash loses nothing.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { ApiError } from "../api/client.ts";
import type { ChangeRow, WriteMeta, WriteResult } from "../api/types.ts";
import { applyDelta, type ChainInfo, checkChainResult, encodeDelta, encryptRecord, type RecordHeader, recordId, vaultKeyFor } from "../crypto/index.ts";
import type { Vault } from "../vault.ts";
import { writeFileAtomic } from "./fsutil.ts";
import { merge3, mergeKindFor } from "./merge.ts";

export type PluginOrigin = "core" | "community";

export interface PluginRef {
	origin: PluginOrigin;
	id: string;
}

export interface PluginIdentity {
	name: string;
	source: string;
}

export interface PluginLimits {
	maxFileBytes: number;
	maxPluginBytes: number;
	maxFiles: number;
}

export interface ActivePlugin extends PluginRef {
	identity: PluginIdentity;
	limits: PluginLimits;
}

export interface PluginFileStat {
	/** Path relative to the plugin's data folder, `/`-separated. */
	rel: string;
	size: number;
	mtimeMs: number;
}

/** File access while a plugin's backend is stopped. */
export interface PluginFileIO {
	read(rel: string): Promise<Uint8Array | null>;
	write(rel: string, data: Uint8Array): Promise<void>;
	remove(rel: string): Promise<void>;
}

/** What the chain engine needs from the app (LearnHarness ADR 0007). */
export interface PluginFilesHost {
	/** Plugins that are installed, enabled and (community) have sync turned on on this device. */
	activePlugins(): Promise<ActivePlugin[]>;
	/** The plugin's syncable files, after the host's exclusion rules. */
	listPluginFiles(p: PluginRef): Promise<PluginFileStat[]>;
	readPluginFile(p: PluginRef, rel: string): Promise<Uint8Array | null>;
	/**
	 * Runs `fn` while the plugin's backend is stopped (no running operation, no live worker), then
	 * starts it again. Resolves false when the plugin refused to start with the new files, and
	 * "busy" without running `fn` when the plugin has work in progress (the apply waits).
	 */
	withPluginStopped(p: PluginRef, fn: (io: PluginFileIO) => Promise<void>): Promise<boolean | "busy">;
	/** True while the plugin has work in progress; received files then wait for a later sync. */
	pluginBusy?(p: PluginRef): boolean | Promise<boolean>;
	/** Stores a device-local conflict copy of a plugin file; it never syncs. */
	writePluginConflict(p: PluginRef, rel: string, data: Uint8Array): Promise<void>;
	/**
	 * False for a file this device's rules keep out of sync (the plugin manifest's `sync.exclude`).
	 * The sender applies its own rules when it lists files; the receiver applies its own here, so
	 * another device cannot write a file that this device would never have sent (ADR 0007).
	 */
	acceptsPluginFile?(p: PluginRef, rel: string): boolean | Promise<boolean>;
}

export const DEFAULT_LIMITS: Record<PluginOrigin, PluginLimits> = {
	core: { maxFileBytes: 4 << 20, maxPluginBytes: 64 << 20, maxFiles: 5000 },
	community: { maxFileBytes: 1 << 20, maxPluginBytes: 16 << 20, maxFiles: 5000 },
};

/** Extensions that may sync; everything else (code, markup, scripts) never does. */
export const SYNC_EXTENSIONS = ["json", "jsonl", "md", "txt", "png", "webp"] as const;
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REL_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_REL_DEPTH = 3;
const SLOT_DIGITS = 12;
/** Slots a receiver predicts after each known head, to skip an inactive plugin's records unread. */
const PREDICT = 16;
const COMPACT_FRACTION = 0.5;
const COMPACT_DELTAS = 100;
const PUSH_INTERVAL_MS = 60_000;
const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;
const MAX_META_BYTES = 8 << 20;
/** Slots that may wait for their predecessors: per chain, and for all chains together. */
export const MAX_PENDING_PER_CHAIN = 1000;
export const MAX_PENDING_TOTAL = 20_000;

/** Throws unless `rel` is a syncable plugin file path (ADR 0007). */
export function isSyncablePluginPath(rel: string): boolean {
	const parts = rel.split("/");
	if (parts.length === 0 || parts.length > MAX_REL_DEPTH || !parts.every((p) => REL_SEGMENT_RE.test(p))) return false;
	const name = parts[parts.length - 1] as string;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return false;
	return (SYNC_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

const pad = (n: number) => String(n).padStart(SLOT_DIGITS, "0");
const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const keyOf = (p: PluginRef) => `${p.origin}/${p.id}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function pluginFileChain(p: PluginRef, rel: string): string {
	return `pf/${p.origin}/${p.id}/${rel}`;
}
function indexChain(p: PluginRef): string {
	return `pi/${p.origin}/${p.id}`;
}
const REGISTRY = "pr";

export type ParsedSlot =
	| { kind: "file"; chain: string; plugin: PluginRef; rel: string; slot: number }
	| { kind: "index"; chain: string; plugin: PluginRef; slot: number }
	| { kind: "registry"; chain: string; slot: number };

/** Parses a slot record path, or returns null when it is not one. */
export function parseSlotPath(path: string): ParsedSlot | null {
	const parts = path.split("/");
	const slotText = parts[parts.length - 1] as string;
	if (!/^[0-9]{12}$/.test(slotText)) return null;
	const slot = Number(slotText);
	if (slot < 1) return null;
	if (parts[0] === "pr" && parts.length === 2) return { kind: "registry", chain: REGISTRY, slot };
	const origin = parts[1];
	const id = parts[2];
	if ((origin !== "core" && origin !== "community") || !id || !PLUGIN_ID_RE.test(id)) return null;
	const plugin = { origin, id } as PluginRef;
	if (parts[0] === "pi" && parts.length === 4) return { kind: "index", chain: indexChain(plugin), plugin, slot };
	if (parts[0] === "pf" && parts.length >= 5) {
		const rel = parts.slice(3, -1).join("/");
		if (!isSyncablePluginPath(rel)) return null;
		return { kind: "file", chain: pluginFileChain(plugin, rel), plugin, rel, slot };
	}
	return null;
}

interface SlotRef {
	slot: number;
	seq: number;
	/** writtenAt of the slot, ms since the epoch. */
	at: number;
}

interface ChainHead {
	head: number;
	headSha: string;
	size: number;
	/** Newest full slot. */
	full: number;
	deltaBytes: number;
	deltaCount: number;
	/** Live (not tombstoned) slots this device knows, oldest first. */
	slots: SlotRef[];
	/** The file was deleted (its head slot tombstoned); headSha stays the last content's hash. */
	deleted?: boolean;
	/** A deletion received from another device, not yet applied to the local file. */
	deletionPending?: boolean;
}

interface FileChainState extends ChainHead {
	stat?: { size: number; mtimeMs: number; sha: string };
	lastPushAt?: number;
}

interface PendingSlot {
	chain: string;
	slot: number;
	seq: number;
	at: number;
	type: "full" | "delta";
	size: number;
	sha256: string;
	baseSha256?: string;
	recordId: string;
}

interface ChainState {
	v: 1;
	files: Record<string, FileChainState>;
	meta: Record<string, ChainHead>;
	/** Plugins whose data this device has received in full since they became active. */
	active: string[];
	pending: PendingSlot[];
	lastSweep?: number;
}

export interface IndexEntry {
	path: string;
	full: number;
	head: number;
	size: number;
	sha256: string;
}

export interface RegistryEntry extends PluginRef {
	name: string;
	source: string;
}

export interface ChainStatus {
	/** Plugins over a limit, with the reason; their files do not sync until fixed. */
	overLimit: Record<string, string>;
	/** Conflict copies written by merges since start. */
	conflicts: number;
	/** Files refused when received (bad delta, size). */
	refused: number;
}

export interface ChainSyncOptions {
	vault: Vault;
	host: PluginFilesHost;
	stateDir: string;
	deviceId: string;
	now: () => Date;
	openRecord: (c: { recordId: string; kind: "doc" | "seg"; sha256: string }) => Promise<{ header: RecordHeader; body: Uint8Array }>;
	onStatus?: () => void;
}

/** One write in a records batch. */
interface Item {
	meta: WriteMeta;
	envelope: Uint8Array;
	onAccepted: (seq: number) => Promise<void> | void;
	onConflict?: () => void;
	/** The slot this write creates; a 409 on it may mean the number is taken by a tombstone. */
	slot?: { chain: string; slot: number; meta: boolean };
}

export class ChainSync {
	private readonly o: ChainSyncOptions;
	private state: ChainState = { v: 1, files: {}, meta: {}, active: [], pending: [] };
	private skipIds = new Map<string, string>();
	private skipDirty = true;
	private statusValue: ChainStatus = { overLimit: {}, conflicts: 0, refused: 0 };
	/** Set when a write lost a slot race: the engine runs another cycle (pull, merge, push). */
	needsCycle = false;
	private activeCache: ActivePlugin[] | null = null;
	/** Plugins whose slots are being fetched by `activate`; their slots are accepted before they are active. */
	private backfilling = new Set<string>();
	/** Plugins whose vault data was deleted; the next registry slot leaves them out. */
	private deletedPlugins = new Set<string>();

	constructor(o: ChainSyncOptions) {
		this.o = o;
	}

	private get dir(): string {
		return join(this.o.stateDir, "chains");
	}
	private get statePath(): string {
		return join(this.dir, "state.json");
	}
	private shadowPath(chain: string): string {
		return join(this.dir, "shadow", createHash("sha256").update(chain).digest("hex"));
	}
	private pendingPath(recordId: string): string {
		return join(this.dir, "pending", recordId);
	}

	async init(): Promise<void> {
		try {
			const s = JSON.parse(await readFile(this.statePath, "utf8")) as ChainState;
			if (s.v === 1) this.state = s;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
	}

	status(): ChainStatus {
		return { ...this.statusValue, overLimit: { ...this.statusValue.overLimit } };
	}

	private async save(): Promise<void> {
		await writeFileAtomic(this.statePath, JSON.stringify(this.state));
	}

	private async readShadow(chain: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.shadowPath(chain)));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}

	private async writeShadow(chain: string, data: Uint8Array): Promise<void> {
		await writeFileAtomic(this.shadowPath(chain), data);
	}

	private async active(refresh = false): Promise<ActivePlugin[]> {
		if (refresh || !this.activeCache) this.activeCache = await this.o.host.activePlugins();
		return this.activeCache;
	}

	private async activePlugin(p: PluginRef): Promise<ActivePlugin | undefined> {
		return (await this.active()).find((a) => a.origin === p.origin && a.id === p.id && this.state.active.includes(keyOf(a)));
	}

	/** The host's set of active plugins changed (enabled, disabled, installed, sync turned on or off). */
	invalidate(): void {
		this.activeCache = null;
		this.skipDirty = true;
	}

	// ---------------------------------------------------------------- registry and indexes

	async registry(): Promise<RegistryEntry[]> {
		return parseRegistry(await this.readShadow(REGISTRY));
	}

	async index(p: PluginRef): Promise<IndexEntry[]> {
		return parseIndex(await this.readShadow(indexChain(p)));
	}

	private async buildIndex(p: PluginRef): Promise<Uint8Array> {
		const prefix = `pf/${p.origin}/${p.id}/`;
		const lines = Object.entries(this.state.files)
			.filter(([chain, f]) => chain.startsWith(prefix) && !f.deleted && f.head > 0)
			.map(([chain, f]) => ({ path: chain.slice(prefix.length), full: f.full, head: f.head, size: f.size, sha256: f.headSha }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return enc.encode(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
	}

	private async buildRegistry(plugins: ActivePlugin[]): Promise<Uint8Array> {
		const map = new Map((await this.registry()).map((e) => [keyOf(e), e]));
		for (const k of this.deletedPlugins) map.delete(k);
		for (const p of plugins) if (!this.deletedPlugins.has(keyOf(p))) map.set(keyOf(p), { origin: p.origin, id: p.id, name: p.identity.name, source: p.identity.source });
		const lines = [...map.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
		return enc.encode(lines.map((l) => `${JSON.stringify({ origin: l.origin, id: l.id, name: l.name, source: l.source })}\n`).join(""));
	}

	/**
	 * Record ids this device may skip without downloading: the next slots of every file of a
	 * registered plugin that is not active here.
	 */
	private async computeSkipIds(): Promise<void> {
		if (!this.skipDirty) return;
		const ik = this.o.vault.keys.ik;
		const active = new Set((await this.active()).map(keyOf));
		const ids = new Map<string, string>();
		for (const p of await this.registry()) {
			if (active.has(keyOf(p))) continue;
			for (const e of await this.index(p)) {
				if (!isSyncablePluginPath(e.path)) continue;
				const chain = pluginFileChain(p, e.path);
				for (let s = e.full; s <= e.head + PREDICT; s++) ids.set(recordId(ik, `${chain}/${pad(s)}`), keyOf(p));
			}
		}
		this.skipIds = ids;
		this.skipDirty = false;
	}

	/** True when a change belongs to a plugin that is not active here: it is skipped unread. */
	async skipWithoutDownload(c: ChangeRow): Promise<boolean> {
		await this.computeSkipIds();
		return this.skipIds.has(c.recordId);
	}

	// ---------------------------------------------------------------- receiving

	/** Takes a decrypted slot record from the pull. Applying waits for `resolve`. */
	async receive(c: ChangeRow, header: RecordHeader, body: Uint8Array): Promise<void> {
		if (header.kind !== "doc") return;
		const parsed = parseSlotPath(header.path);
		if (!parsed) return;
		const at = Date.parse(header.writtenAt) || this.o.now().getTime();
		if (parsed.kind === "file" && !this.backfilling.has(keyOf(parsed.plugin)) && !(await this.activePlugin(parsed.plugin))) return; // arrives with the backfill on activation
		if (header.deleted) {
			await this.noteTombstone(parsed, c.seq);
			return;
		}
		const chain = header.chain;
		if (!chain) {
			this.statusValue.refused++;
			return;
		}
		// Limits on what another device can make this one keep (ADR 0007). The sender checks them
		// before it pushes; a device that was taken over does not, so the receiver checks again
		// before anything is written.
		if (!(await this.withinReceiveLimits(parsed, chain.size, body.length))) {
			this.statusValue.refused++;
			return;
		}
		const known = this.chainHead(parsed);
		if (known && (known.slots.some((s) => s.slot === parsed.slot) || (parsed.slot <= known.head && !known.deleted))) {
			// Already applied (our own write or seen before): remember its seq.
			const ref = known.slots.find((s) => s.slot === parsed.slot);
			if (ref) ref.seq = c.seq;
			return;
		}
		await mkdir(join(this.dir, "pending"), { recursive: true });
		await writeFileAtomic(this.pendingPath(c.recordId), body);
		this.state.pending = this.state.pending.filter((p) => !(p.chain === parsed.chain && p.slot === parsed.slot));
		this.state.pending.push({
			chain: parsed.chain, slot: parsed.slot, seq: c.seq, at, type: chain.type, size: chain.size, sha256: chain.sha256,
			...(chain.type === "delta" ? { baseSha256: chain.baseSha256 } : {}), recordId: c.recordId,
		});
	}

	/** The receive-side checks of `receive`: size, the device's own exclusion rules, file count, pending slots. */
	private async withinReceiveLimits(parsed: ParsedSlot, declaredSize: number, bodyBytes: number): Promise<boolean> {
		if (parsed.kind !== "file") return declaredSize <= MAX_META_BYTES && bodyBytes <= MAX_META_BYTES;
		const limits = (await this.activePlugin(parsed.plugin))?.limits ?? DEFAULT_LIMITS[parsed.plugin.origin];
		if (declaredSize > limits.maxFileBytes || bodyBytes > limits.maxFileBytes) return false;
		if (this.o.host.acceptsPluginFile && !(await this.o.host.acceptsPluginFile(parsed.plugin, parsed.rel))) return false;
		const pendingOfChain = this.state.pending.filter((p) => p.chain === parsed.chain).length;
		if (pendingOfChain >= MAX_PENDING_PER_CHAIN || this.state.pending.length >= MAX_PENDING_TOTAL) return false;
		// A file this device does not know yet counts against the plugin's file limit.
		if (!this.state.files[parsed.chain]) {
			const prefix = `pf/${parsed.plugin.origin}/${parsed.plugin.id}/`;
			const chains = new Set(Object.entries(this.state.files).filter(([c, f]) => c.startsWith(prefix) && !f.deleted).map(([c]) => c));
			for (const p of this.state.pending) if (p.chain.startsWith(prefix)) chains.add(p.chain);
			if (!chains.has(parsed.chain) && chains.size >= limits.maxFiles) return false;
		}
		return true;
	}

	private chainHead(p: ParsedSlot): ChainHead | undefined {
		return p.kind === "file" ? this.state.files[p.chain] : this.state.meta[p.chain];
	}

	private async noteTombstone(p: ParsedSlot, _seq: number): Promise<void> {
		const head = this.chainHead(p);
		if (!head || (head.deleted && head.head < p.slot)) {
			// Only the tombstone is known (the chain was deleted before this device saw it).
			await this.placeholder(p.chain, p.slot, p.kind !== "file");
			return;
		}
		head.slots = head.slots.filter((s) => s.slot !== p.slot);
		// The sweep never tombstones a head, so a tombstoned head means the file was deleted.
		if (p.slot === head.head && p.kind === "file" && !head.deleted) {
			head.deleted = true;
			head.deletionPending = true;
		}
	}

	/**
	 * Applies received slots: registry and indexes first, then plugin files, merged with local
	 * changes. Called after each page of changes.
	 */
	async resolve(): Promise<void> {
		if (this.state.pending.length === 0 && !Object.values(this.state.files).some((f) => f.deletionPending)) {
			await this.save();
			return;
		}
		// Registry and indexes.
		const metaChains = [...new Set(this.state.pending.filter((p) => !p.chain.startsWith("pf/")).map((p) => p.chain))];
		for (const chain of metaChains) {
			const next = await this.advance(chain, this.state.meta[chain], MAX_META_BYTES);
			if (!next) continue;
			this.state.meta[chain] = next.head;
			await this.writeShadow(chain, next.content);
			await next.commit();
			this.skipDirty = true;
		}
		// Plugin files, grouped by plugin so each plugin stops once.
		const byPlugin = new Map<string, { plugin: ActivePlugin; chains: Set<string> }>();
		const addChain = async (chain: string) => {
			const parsed = parseSlotPath(`${chain}/${pad(1)}`);
			if (!parsed || parsed.kind !== "file") return;
			const plugin = await this.activePlugin(parsed.plugin);
			if (!plugin) return;
			const g = byPlugin.get(keyOf(plugin)) ?? { plugin, chains: new Set<string>() };
			g.chains.add(chain);
			byPlugin.set(keyOf(plugin), g);
		};
		for (const p of this.state.pending) if (p.chain.startsWith("pf/")) await addChain(p.chain);
		for (const [chain, f] of Object.entries(this.state.files)) if (f.deletionPending) await addChain(chain);
		for (const { plugin, chains } of byPlugin.values()) await this.applyFiles(plugin, [...chains]);
		await this.save();
	}

	/**
	 * Moves a chain forward over its pending slots: consecutive slots from the head, or a jump to
	 * the newest pending full slot. Returns the new head and content, or null when nothing applies.
	 */
	private async advance(chain: string, head: ChainHead | undefined, maxSize: number): Promise<{ head: ChainHead; content: Uint8Array; commit: () => Promise<void> } | null> {
		const pending = this.state.pending.filter((p) => p.chain === chain).sort((a, b) => a.slot - b.slot);
		if (pending.length === 0) return null;
		let cur: ChainHead | undefined = head && !head.deleted ? { ...head, slots: [...head.slots] } : undefined;
		let content: Uint8Array | null = cur ? await this.readShadow(chain) : null;
		if (cur && content === null) cur = undefined; // the shadow is gone: start again from a full slot
		let changed = false;
		const used: PendingSlot[] = [];
		const usedSet = new Set<PendingSlot>();
		const bySlot = new Map(pending.map((x) => [x.slot, x] as const));
		for (;;) {
			const nextSlot = cur ? cur.head + 1 : -1;
			const next = bySlot.get(nextSlot);
			let p = next && !usedSet.has(next) ? next : undefined;
			if (!p) {
				// The newest full slot after the head that was not tried yet (pending is sorted by slot).
				for (let i = pending.length - 1; i >= 0; i--) {
					const x = pending[i] as PendingSlot;
					if (cur && x.slot <= cur.head) break;
					if (x.type === "full" && !usedSet.has(x)) {
						p = x;
						break;
					}
				}
			}
			if (!p) break;
			used.push(p);
			usedSet.add(p);
			let body: Uint8Array;
			try {
				body = new Uint8Array(await readFile(this.pendingPath(p.recordId)));
			} catch {
				continue;
			}
			try {
				if (p.size > maxSize) throw new Error("over the size limit");
				let result: Uint8Array;
				if (p.type === "full") result = body;
				else {
					if (!content || !cur || p.baseSha256 !== cur.headSha) throw new Error("based on another version");
					result = applyDelta(content, body, { maxSize });
				}
				checkChainResult(result, p.size, p.sha256);
				const isFull = p.type === "full";
				cur = {
					head: p.slot, headSha: p.sha256, size: p.size, full: isFull ? p.slot : (cur?.full ?? p.slot),
					deltaBytes: isFull ? 0 : (cur?.deltaBytes ?? 0) + body.length, deltaCount: isFull ? 0 : (cur?.deltaCount ?? 0) + 1,
					slots: [...(cur?.slots ?? []), { slot: p.slot, seq: p.seq, at: p.at }],
				};
				content = result;
				changed = true;
			} catch {
				this.statusValue.refused++;
			}
		}
		// Drop what was used or is now behind the head, once the caller has applied the result.
		const done = new Set(used.map((u) => u.recordId));
		const final = cur;
		const keep = (x: PendingSlot) => x.chain !== chain || (!done.has(x.recordId) && (!final || x.slot > final.head));
		const commit = async () => {
			for (const x of this.state.pending.filter((x) => !keep(x))) await rm(this.pendingPath(x.recordId), { force: true });
			this.state.pending = this.state.pending.filter(keep);
		};
		if (!changed || !cur || !content) {
			await commit();
			return null;
		}
		return { head: cur, content, commit };
	}

	private async applyFiles(plugin: ActivePlugin, chains: string[]): Promise<void> {
		if (await this.o.host.pluginBusy?.(plugin)) return; // the slots stay pending for a later sync
		const updates: { chain: string; rel: string; head?: ChainHead; content?: Uint8Array; deleted?: boolean; commit?: () => Promise<void> }[] = [];
		for (const chain of chains) {
			const rel = chain.slice(`pf/${plugin.origin}/${plugin.id}/`.length);
			const f = this.state.files[chain];
			if (f?.deletionPending) {
				updates.push({ chain, rel, deleted: true });
				continue;
			}
			const next = await this.advance(chain, f, plugin.limits.maxFileBytes);
			if (next) updates.push({ chain, rel, head: next.head, content: next.content, commit: next.commit });
		}
		if (updates.length === 0) return;
		const merged = new Map<string, { remote: Uint8Array; local: Uint8Array }>();
		const run = (useRemote: boolean) =>
			this.o.host.withPluginStopped(plugin, async (io) => {
				for (const u of updates) {
					const f = this.state.files[u.chain];
					const local = await io.read(u.rel);
					const shadow = f && !f.deleted ? await this.readShadow(u.chain) : null;
					const localChanged = local !== null && (!f || sha256Hex(local) !== f.headSha);
					if (u.deleted) {
						// Deleted elsewhere: an unchanged file goes; a changed one stays and the next push
						// writes it as a full slot after the old head (the edit wins).
						if (local !== null && f && sha256Hex(local) === f.headSha) await io.remove(u.rel);
						this.state.files[u.chain] = { head: f?.head ?? 0, headSha: "", size: 0, full: f?.head ?? 0, deltaBytes: 0, deltaCount: 0, slots: [], deleted: true };
						await rm(this.shadowPath(u.chain), { force: true });
						continue;
					}
					const remote = u.content as Uint8Array;
					let result = remote;
					if (localChanged && local) {
						if (useRemote) {
							await this.o.host.writePluginConflict(plugin, u.rel, local);
							this.statusValue.conflicts++;
						} else {
							const m = merge3(shadow, local, remote, mergeKindFor(u.rel));
							result = m.merged;
							if (m.conflicts.length > 0) {
								await this.o.host.writePluginConflict(plugin, u.rel, local);
								this.statusValue.conflicts++;
							}
							if (sha256Hex(result) !== sha256Hex(remote)) merged.set(u.chain, { remote, local });
						}
					}
					if (!local || sha256Hex(local) !== sha256Hex(result)) await io.write(u.rel, result);
					await this.writeShadow(u.chain, remote);
					const prev = this.state.files[u.chain];
					this.state.files[u.chain] = { ...(u.head as ChainHead), ...(prev?.lastPushAt ? { lastPushAt: prev.lastPushAt } : {}) };
				}
			});
		const ok = await run(false);
		if (ok === "busy") return; // nothing was written; the slots stay pending
		for (const u of updates) await u.commit?.();
		if (!ok && merged.size > 0) {
			// The plugin refused a merged file: write the vault's version, keep the local one as a conflict copy.
			const retry = updates.filter((u) => merged.has(u.chain));
			const refused = await this.o.host.withPluginStopped(plugin, async (io) => {
				for (const u of retry) {
					const m = merged.get(u.chain) as { remote: Uint8Array; local: Uint8Array };
					await this.o.host.writePluginConflict(plugin, u.rel, m.local);
					this.statusValue.conflicts++;
					await io.write(u.rel, m.remote);
				}
			});
			if (!refused) this.statusValue.refused++;
		}
		this.o.onStatus?.();
	}

	/**
	 * Deletes a plugin's data from the vault (Settings, "Delete synced data"): tombstones every
	 * known slot of its files and its index, and removes it from the registry. Local files stay.
	 */
	async deletePluginData(p: PluginRef): Promise<number> {
		const vault = this.o.vault;
		const keys = vault.keys;
		const epoch = vault.epoch;
		const vk = vaultKeyFor(keys, epoch) as Uint8Array;
		const writtenAt = this.o.now().toISOString();
		const items: Item[] = [];
		const tombstone = async (path: string) => {
			const id = recordId(keys.ik, path);
			let head: ChangeRow | undefined;
			try {
				head = (await vault.api.get<{ versions: ChangeRow[] }>(`/v1/history/${id}`, vault.auth())).versions[0];
			} catch (err) {
				if (err instanceof ApiError && err.status === 404) return;
				throw err;
			}
			if (!head || head.tombstone) return;
			const header: RecordHeader = { kind: "doc", path, baseSeq: head.seq, deleted: true, deviceId: this.o.deviceId, writtenAt };
			const sealed = encryptRecord(keys.accountId, keys.ik, epoch, vk, { header, body: new Uint8Array(0) });
			items.push({ meta: { recordId: sealed.recordId, kind: "doc", baseSeq: head.seq, epoch, tombstone: true, sha256: sha256Hex(sealed.envelope), size: sealed.envelope.length }, envelope: sealed.envelope, onAccepted: () => undefined });
		};
		const prefix = `pf/${p.origin}/${p.id}/`;
		const files = new Map<string, number>();
		for (const e of await this.index(p)) if (isSyncablePluginPath(e.path)) files.set(pluginFileChain(p, e.path), e.head);
		for (const [chain, f] of Object.entries(this.state.files)) if (chain.startsWith(prefix)) files.set(chain, Math.max(files.get(chain) ?? 0, f.head));
		for (const [chain, head] of files) for (let s = 1; s <= head; s++) await tombstone(`${chain}/${pad(s)}`);
		const index = this.state.meta[indexChain(p)];
		for (let s = 1; s <= (index?.head ?? 0); s++) await tombstone(`${indexChain(p)}/${pad(s)}`);
		const n = await this.post(items);
		for (const chain of files.keys()) {
			delete this.state.files[chain];
			await rm(this.shadowPath(chain), { force: true });
		}
		delete this.state.meta[indexChain(p)];
		await rm(this.shadowPath(indexChain(p)), { force: true });
		this.state.active = this.state.active.filter((k) => k !== keyOf(p));
		this.deletedPlugins.add(keyOf(p));
		this.invalidate();
		await this.save();
		return n;
	}

	// ---------------------------------------------------------------- activation (backfill)

	/**
	 * Brings an active plugin's files up to date from the vault: the newest full slot of each file
	 * in the plugin's index and the deltas after it. Local files merge with the vault's (no common
	 * ancestor when this device never synced them). Called before the plugin's backend starts.
	 */
	async activate(p: ActivePlugin): Promise<void> {
		const key = keyOf(p);
		const entries = await this.index(p);
		const vault = this.o.vault;
		for (const e of entries) {
			if (!isSyncablePluginPath(e.path)) continue;
			const chain = pluginFileChain(p, e.path);
			const f = this.state.files[chain];
			const from = f && !f.deleted && f.head >= e.full ? f.head + 1 : e.full;
			for (let s = from; s <= e.head; s++) {
				if (this.state.pending.some((x) => x.chain === chain && x.slot === s)) continue;
				const id = recordId(vault.keys.ik, `${chain}/${pad(s)}`);
				let hist: { versions: ChangeRow[] };
				try {
					hist = await vault.api.get<{ versions: ChangeRow[] }>(`/v1/history/${id}`, vault.auth());
				} catch (err) {
					if (err instanceof ApiError && err.status === 404) continue;
					throw err;
				}
				const head = hist.versions[0];
				if (!head || head.tombstone) continue;
				const { header, body } = await this.o.openRecord({ recordId: id, kind: "doc", sha256: head.sha256 });
				if (header.path !== `${chain}/${pad(s)}`) continue;
				this.backfilling.add(key);
				try {
					await this.receive(head, header, body);
				} finally {
					this.backfilling.delete(key);
				}
			}
		}
		// Every slot is pending (and on disk) before the plugin counts as active: a crash before this
		// point fetches again, a crash after it applies the pending slots on the next resolve.
		if (!this.state.active.includes(key)) this.state.active.push(key);
		this.invalidate();
		await this.save();
		await this.resolve();
	}

	/** A plugin was uninstalled or its sync turned off: forget its local state, keep the vault's copy. */
	async forget(p: PluginRef): Promise<void> {
		const prefix = `pf/${p.origin}/${p.id}/`;
		for (const chain of Object.keys(this.state.files)) {
			if (!chain.startsWith(prefix)) continue;
			await rm(this.shadowPath(chain), { force: true });
			delete this.state.files[chain];
		}
		for (const x of this.state.pending.filter((x) => x.chain.startsWith(prefix))) await rm(this.pendingPath(x.recordId), { force: true });
		this.state.pending = this.state.pending.filter((x) => !x.chain.startsWith(prefix));
		this.state.active = this.state.active.filter((k) => k !== keyOf(p));
		this.activeCache = null;
		this.skipDirty = true;
		await this.save();
	}

	/** A plugin was disabled: it stops syncing; its local data and state stay for catching up later. */
	async deactivate(p: PluginRef): Promise<void> {
		this.state.active = this.state.active.filter((k) => k !== keyOf(p));
		this.activeCache = null;
		this.skipDirty = true;
		await this.save();
	}

	// ---------------------------------------------------------------- pushing

	/**
	 * Pushes changed files of active plugins as new slots, then their indexes and the registry.
	 * `flush` ignores the per-file upload interval (shutdown).
	 */
	async push(flush = false): Promise<number> {
		const plugins = await this.active(true);
		for (const p of plugins) if (!this.state.active.includes(keyOf(p))) await this.activate(p);
		for (const k of [...this.state.active]) {
			if (!plugins.some((p) => keyOf(p) === k)) this.state.active = this.state.active.filter((x) => x !== k);
		}
		const vault = this.o.vault;
		const keys = vault.keys;
		const epoch = vault.epoch;
		const vk = vaultKeyFor(keys, epoch) as Uint8Array;
		const writtenAt = this.o.now().toISOString();
		const nowMs = this.o.now().getTime();
		const seal = (path: string, body: Uint8Array, chain: ChainInfo) => {
			const header: RecordHeader = { kind: "doc", path, baseSeq: 0, deleted: false, deviceId: this.o.deviceId, writtenAt, chain };
			const sealed = encryptRecord(keys.accountId, keys.ik, epoch, vk, { header, body });
			return { meta: { recordId: sealed.recordId, kind: "doc" as const, baseSeq: 0, epoch, tombstone: false, sha256: sha256Hex(sealed.envelope), size: sealed.envelope.length }, envelope: sealed.envelope };
		};
		const tomb = (path: string, seq: number) => {
			const header: RecordHeader = { kind: "doc", path, baseSeq: seq, deleted: true, deviceId: this.o.deviceId, writtenAt };
			const sealed = encryptRecord(keys.accountId, keys.ik, epoch, vk, { header, body: new Uint8Array(0) });
			return { meta: { recordId: sealed.recordId, kind: "doc" as const, baseSeq: seq, epoch, tombstone: true, sha256: sha256Hex(sealed.envelope), size: sealed.envelope.length }, envelope: sealed.envelope };
		};

		let pushed = 0;
		const touched = new Set<string>();
		const fileItems: Item[] = [];
		for (const p of plugins) {
			const key = keyOf(p);
			const files = (await this.o.host.listPluginFiles(p)).filter((s) => isSyncablePluginPath(s.rel));
			const total = files.reduce((n, s) => n + s.size, 0);
			if (files.length > p.limits.maxFiles) this.statusValue.overLimit[key] = `more than ${p.limits.maxFiles} files`;
			else if (total > p.limits.maxPluginBytes) this.statusValue.overLimit[key] = `more than ${p.limits.maxPluginBytes} bytes`;
			else delete this.statusValue.overLimit[key];
			if (this.statusValue.overLimit[key]) continue;
			const present = new Set<string>();
			for (const s of files) {
				const chain = pluginFileChain(p, s.rel);
				present.add(chain);
				if (s.size > p.limits.maxFileBytes) {
					this.statusValue.overLimit[key] = `${s.rel} is larger than ${p.limits.maxFileBytes} bytes`;
					continue;
				}
				const f = this.state.files[chain];
				if (f && !f.deleted && !flush && f.lastPushAt && nowMs - f.lastPushAt < PUSH_INTERVAL_MS) continue;
				let sha: string;
				let data: Uint8Array | null = null;
				if (f?.stat && f.stat.size === s.size && f.stat.mtimeMs === s.mtimeMs) sha = f.stat.sha;
				else {
					data = await this.o.host.readPluginFile(p, s.rel);
					if (data === null) continue;
					sha = sha256Hex(data);
				}
				if (f && !f.deleted && sha === f.headSha) {
					f.stat = { size: s.size, mtimeMs: s.mtimeMs, sha };
					continue;
				}
				data ??= await this.o.host.readPluginFile(p, s.rel);
				if (data === null) continue;
				const content = data;
				const live = f && !f.deleted ? f : undefined;
				const shadow = live ? await this.readShadow(chain) : null;
				const slot = (f?.head ?? 0) + 1;
				let delta: Uint8Array | null = null;
				if (live && shadow && live.deltaCount < COMPACT_DELTAS) {
					delta = encodeDelta(shadow, content);
					if (delta && live.deltaBytes + delta.length > COMPACT_FRACTION * content.length) delta = null;
				}
				const sealed = delta && live
					? seal(`${chain}/${pad(slot)}`, delta, { type: "delta", size: content.length, sha256: sha, baseSha256: live.headSha })
					: seal(`${chain}/${pad(slot)}`, content, { type: "full", size: content.length, sha256: sha });
				const deltaLen = delta?.length ?? 0;
				const isDelta = delta !== null;
				fileItems.push({
					...sealed,
					slot: { chain, slot, meta: false },
					onAccepted: async (seq) => {
						const prev = this.state.files[chain];
						const at = nowMs;
						this.state.files[chain] = {
							head: slot, headSha: sha, size: content.length,
							full: isDelta && prev ? prev.full : slot,
							deltaBytes: isDelta && prev ? prev.deltaBytes + deltaLen : 0,
							deltaCount: isDelta && prev ? prev.deltaCount + 1 : 0,
							// Slots before a new full slot stay until the sweep tombstones them after 90 days.
							slots: [...(prev && !prev.deleted ? prev.slots : []), { slot, seq, at }],
							stat: { size: s.size, mtimeMs: s.mtimeMs, sha }, lastPushAt: nowMs,
						};
						await this.writeShadow(chain, content);
						touched.add(key);
					},
					onConflict: () => {
						this.needsCycle = true;
					},
				});
			}
			// Files deleted on this device: tombstone every live slot.
			const prefix = `pf/${p.origin}/${p.id}/`;
			for (const [chain, f] of Object.entries(this.state.files)) {
				if (!chain.startsWith(prefix) || f.deleted || present.has(chain) || f.head === 0) continue;
				const slots = [...f.slots];
				for (const s of slots) {
					fileItems.push({
						...tomb(`${chain}/${pad(s.slot)}`, s.seq),
						onAccepted: async () => {
							const cur = this.state.files[chain];
							if (!cur) return;
							cur.slots = cur.slots.filter((x) => x.slot !== s.slot);
							if (s.slot === cur.head) cur.deleted = true;
							if (cur.slots.length === 0) {
								cur.deleted = true;
								await rm(this.shadowPath(chain), { force: true });
							}
							touched.add(key);
						},
						onConflict: () => {
							this.needsCycle = true;
						},
					});
				}
			}
		}
		pushed += await this.post(fileItems);

		// Indexes of plugins whose files changed, and the registry.
		const metaItems: Item[] = [];
		const metaWrite = async (chain: string, content: Uint8Array) => {
			const head = this.state.meta[chain];
			const shadow = head ? await this.readShadow(chain) : null;
			if (shadow && sha256Hex(shadow) === sha256Hex(content)) return;
			const slot = (head?.head ?? 0) + 1;
			const sha = sha256Hex(content);
			let delta = head && shadow && head.deltaCount < COMPACT_DELTAS ? encodeDelta(shadow, content) : null;
			if (delta && head && head.deltaBytes + delta.length > COMPACT_FRACTION * content.length) delta = null;
			const sealed = delta && head
				? seal(`${chain}/${pad(slot)}`, delta, { type: "delta", size: content.length, sha256: sha, baseSha256: head.headSha })
				: seal(`${chain}/${pad(slot)}`, content, { type: "full", size: content.length, sha256: sha });
			const deltaLen = delta?.length ?? 0;
			const isDelta = delta !== null;
			metaItems.push({
				...sealed,
				slot: { chain, slot, meta: true },
				onAccepted: async (seq) => {
					const prev = this.state.meta[chain];
					this.state.meta[chain] = {
						head: slot, headSha: sha, size: content.length, full: isDelta && prev ? prev.full : slot,
						deltaBytes: isDelta && prev ? prev.deltaBytes + deltaLen : 0, deltaCount: isDelta && prev ? prev.deltaCount + 1 : 0,
						slots: [...(prev?.slots ?? []), { slot, seq, at: nowMs }],
					};
					await this.writeShadow(chain, content);
					this.skipDirty = true;
				},
				onConflict: () => {
					this.needsCycle = true;
				},
			});
		};
		for (const p of plugins) {
			if (!touched.has(keyOf(p)) && this.state.meta[indexChain(p)]) continue;
			if (this.statusValue.overLimit[keyOf(p)] && !touched.has(keyOf(p))) continue;
			await metaWrite(indexChain(p), await this.buildIndex(p));
		}
		if (plugins.length > 0 || this.deletedPlugins.size > 0) await metaWrite(REGISTRY, await this.buildRegistry(plugins));
		pushed += await this.post(metaItems);
		await this.sweep(tomb);
		await this.save();
		this.o.onStatus?.();
		return pushed;
	}

	/** Tombstones slots before each chain's newest full slot once they are older than 90 days (daily). */
	private async sweep(tomb: (path: string, seq: number) => { meta: WriteMeta; envelope: Uint8Array }): Promise<void> {
		const nowMs = this.o.now().getTime();
		if (this.state.lastSweep && nowMs - this.state.lastSweep < DAY_MS) return;
		const items: Item[] = [];
		const cutoff = nowMs - HISTORY_DAYS * DAY_MS;
		const consider = (chain: string, h: ChainHead) => {
			for (const s of h.slots) {
				if (s.slot >= h.full || s.at > cutoff || s.seq === 0) continue;
				items.push({ ...tomb(`${chain}/${pad(s.slot)}`, s.seq), onAccepted: () => { h.slots = h.slots.filter((x) => x.slot !== s.slot); } });
			}
		};
		for (const [chain, f] of Object.entries(this.state.files)) if (!f.deleted) consider(chain, f);
		for (const [chain, m] of Object.entries(this.state.meta)) consider(chain, m);
		await this.post(items);
		this.state.lastSweep = nowMs;
	}

	/**
	 * A slot write answered 409. When the slot is a tombstone this device never saw (a deleted
	 * file or plugin), the chain continues after it: the next write uses the following number.
	 * A live slot arrives with the next pull and is merged as usual.
	 */
	private async slotTaken(at: { chain: string; slot: number; meta: boolean }, id: string): Promise<void> {
		const vault = this.o.vault;
		let head: ChangeRow | undefined;
		try {
			head = (await vault.api.get<{ versions: ChangeRow[] }>(`/v1/history/${id}`, vault.auth())).versions[0];
		} catch {
			return;
		}
		if (head?.tombstone) await this.placeholder(at.chain, at.slot, at.meta);
	}

	/** Records that slot `slot` of a chain exists only as a tombstone, so numbering continues after it. */
	private async placeholder(chain: string, slot: number, meta: boolean): Promise<void> {
		const table = meta ? this.state.meta : this.state.files;
		const h = table[chain];
		if (h && h.head >= slot) return;
		table[chain] = { head: slot, headSha: "", size: 0, full: slot, deltaBytes: 0, deltaCount: 0, slots: [], deleted: true };
		await rm(this.shadowPath(chain), { force: true });
	}

	private async post(items: Item[]): Promise<number> {
		const vault = this.o.vault;
		let accepted = 0;
		for (let i = 0; i < items.length; ) {
			const batch: Item[] = [];
			let bytes = 0;
			while (i < items.length && batch.length < 100 && (batch.length === 0 || bytes + (items[i] as Item).envelope.length <= 48 << 20)) {
				bytes += (items[i] as Item).envelope.length;
				batch.push(items[i] as Item);
				i++;
			}
			const form = new FormData();
			form.append("writes", JSON.stringify({ writes: batch.map((b) => b.meta) }));
			for (const b of batch) form.append("blob", new Blob([b.envelope as Uint8Array<ArrayBuffer>]), b.meta.sha256);
			const res = await vault.api.multipart<{ results: WriteResult[] }>("/v1/records", form, vault.auth());
			for (let j = 0; j < batch.length; j++) {
				const it = batch[j] as Item;
				const r = res.results[j] as WriteResult;
				if (r.status === "accepted") {
					accepted++;
					await it.onAccepted(r.seq);
				} else if (r.status === "conflict" || r.status === "exists") {
					if (it.slot) await this.slotTaken(it.slot, it.meta.recordId);
					it.onConflict?.();
				} else if (r.status === "stale_epoch") {
					this.needsCycle = true;
				}
			}
			await this.save();
		}
		return accepted;
	}
}

// The registry and the indexes are written by other devices of the account. A device that was
// taken over holds valid keys, so these files decrypt and authenticate and can still say anything.
// Their numbers drive loops (one record id, or one request, per slot between `full` and `head`), so
// an entry such as {"full":1,"head":4000000000} would hang or exhaust every device that reads it,
// on every sync. Entries that are not what an honest device writes are dropped.

/** Plugins a registry may list, files an index may list, and slots one file may span. */
export const MAX_REGISTRY_ENTRIES = 1000;
export const MAX_INDEX_ENTRIES = 10_000;
export const MAX_SLOT_SPAN = 10_000;
const MAX_SLOT = 10 ** SLOT_DIGITS - 1 - PREDICT;
const SHA_RE = /^[0-9a-f]{64}$/;

const isCount = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

export function parseIndex(b: Uint8Array | null): IndexEntry[] {
	const out: IndexEntry[] = [];
	const seen = new Set<string>();
	for (const e of parseJsonl<Record<string, unknown> | null>(b)) {
		if (out.length >= MAX_INDEX_ENTRIES) break;
		if (!e || typeof e !== "object" || Array.isArray(e)) continue;
		const { path, full, head, size, sha256 } = e;
		if (typeof path !== "string" || !isSyncablePluginPath(path) || seen.has(path)) continue;
		if (!isCount(full, 1, MAX_SLOT) || !isCount(head, full, MAX_SLOT) || head - full > MAX_SLOT_SPAN) continue;
		if (!isCount(size, 0, MAX_META_BYTES * 4) || typeof sha256 !== "string" || !SHA_RE.test(sha256)) continue;
		seen.add(path);
		out.push({ path, full, head, size, sha256 });
	}
	return out;
}

export function parseRegistry(b: Uint8Array | null): RegistryEntry[] {
	const out: RegistryEntry[] = [];
	const seen = new Set<string>();
	for (const e of parseJsonl<Record<string, unknown> | null>(b)) {
		if (out.length >= MAX_REGISTRY_ENTRIES) break;
		if (!e || typeof e !== "object" || Array.isArray(e)) continue;
		const { origin, id, name, source } = e;
		if ((origin !== "core" && origin !== "community") || typeof id !== "string" || id.length > 128 || !PLUGIN_ID_RE.test(id)) continue;
		if (typeof name !== "string" || name.length > 200 || typeof source !== "string" || source.length > 2000) continue;
		const key = `${origin}/${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ origin, id, name, source });
	}
	return out;
}

function parseJsonl<T>(b: Uint8Array | null): T[] {
	if (!b) return [];
	const out: T[] = [];
	for (const line of dec.decode(b).split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// a malformed line is skipped; the next full slot replaces it
		}
	}
	return out;
}
