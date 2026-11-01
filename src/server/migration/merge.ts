/**
 * Merging a second device's own data into the vault it just joined (docs/vault-migration.md "Merge").
 *
 * "Use the vault" (join.ts) moves every local file to `<local>/pre-vault-<date>/` and downloads the
 * vault's versions. `mergePreVault` then folds that folder back in, record by record, and never
 * overwrites what the vault holds without keeping the other version:
 *
 * - a session only here is added; a session the vault has too is kept as the vault has it, unless
 *   this device's copy strictly continues it (then the longer one becomes the new head, and the
 *   vault's history still holds the old one); a copy that diverged stays beside the session as a
 *   `.sync-conflict-` copy that LearnHarness's conflict picker lists;
 * - jobs of merged sessions, prompt files, prompt switches, sources and graph ledger lines follow
 *   the same rule (see below); a version that loses goes to `<local>/conflicts/`;
 * - graph lines this device had and the vault lacks are appended to THIS device's own ledger files
 *   (nodes that already exist are marked as links), so no other device's file is ever written.
 *
 * Every record is compared with what is live now, so running it twice changes nothing the second
 * time. The moved-aside folder is never modified. Writes note their intent with the sync engine
 * first (the engine's rule), so a crash pushes the old content, never loses the new.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MergeReport, MovedAsideDto } from "../../core/vault/migration.ts";
import { writeFileAtomic } from "../../store/fs-files.ts";

export type { MergeReport };

export interface MergeSink {
	noteDocumentChanged(path: string): Promise<void>;
	noteLedgerAppended(file: string, offset: number): Promise<void>;
}

export interface MergeOptions {
	dataDir: string;
	localDir: string;
	/** The moved-aside folder to merge, e.g. `<local>/pre-vault-20261101`. */
	fromDir: string;
	/** This device's id: its own ledger files are the only ones that are appended to. */
	deviceId: string;
	sink: MergeSink;
	now?: () => Date;
	/** Called with the changed paths, so open views refresh. */
	changed?: (paths: string[]) => void;
}

const CONFLICT_RE = /\.sync-conflict-/;
const DEVICE_RE = /^dev_[a-z0-9]{8}$/;
const LEDGER_RE = /^graph\/(nodes|chains|sessions|coverage|deletions)(?:\.(dev_[a-z0-9]{8}))?\.jsonl$/;

function walk(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string, rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) visit(path.join(dir, e.name), r);
			else if (e.isFile()) out.push(r);
		}
	};
	visit(root, "");
	return out;
}

const names = (dir: string): string[] => {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
};

const read = (f: string): string | null => {
	try {
		return fs.readFileSync(f, "utf-8");
	} catch {
		return null;
	}
};

function json(text: string | null): unknown {
	if (text === null) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stamp(d: Date): { date: string; time: string } {
	const p = (n: number) => String(n).padStart(2, "0");
	return { date: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` };
}

function freePath(p: string): string {
	if (!fs.existsSync(p)) return p;
	for (let i = 2; ; i++) if (!fs.existsSync(`${p}.${i}`)) return `${p}.${i}`;
}

function messagesOf(v: unknown): string[] | null {
	return isObject(v) && Array.isArray(v.messages) ? v.messages.map((m) => JSON.stringify(m)) : null;
}

const isPrefix = (a: string[], b: string[]): boolean => a.length <= b.length && a.every((x, i) => x === b[i]);

export async function mergePreVault(o: MergeOptions): Promise<MergeReport> {
	if (!DEVICE_RE.test(o.deviceId)) throw new Error(`not a LearnHarness device id: ${o.deviceId}`);
	const now = o.now ?? (() => new Date());
	const s = stamp(now());
	const report: MergeReport = {
		from: o.fromDir,
		at: now().toISOString(),
		sessions: { added: 0, continued: 0, identical: 0, keptVault: 0, conflictCopies: 0 },
		jobs: { added: 0, identical: 0, keptVault: 0, skipped: 0 },
		prompts: { added: 0, identical: 0, keptVault: 0, switchesMerged: false },
		sources: { added: 0 },
		graphLines: { added: 0, linked: 0 },
		leftBehind: [],
	};
	const changedPaths: string[] = [];
	const live = (rel: string) => path.join(o.dataDir, rel);
	const there = (rel: string) => path.join(o.fromDir, rel);
	const setAside = (rel: string, text: string) => {
		const to = freePath(path.join(o.localDir, "conflicts", `${rel}.${s.date}-${s.time}`));
		writeFileAtomic(to, text);
	};
	/** Intent first, then the write. */
	const put = async (rel: string, text: string) => {
		await o.sink.noteDocumentChanged(rel);
		writeFileAtomic(live(rel), text);
		changedPaths.push(rel);
	};

	const files = walk(o.fromDir).filter((f) => !f.startsWith(".stversions/") && !f.startsWith(".stfolder/"));
	const tag = o.deviceId.replace(/[^A-Za-z0-9-]/g, "");

	// ── sessions (chats before jobs: a job needs its session)
	for (const f of files.filter((x) => /^chats\/[^/]+\.json$/.test(x) && !CONFLICT_RE.test(x))) {
		const id = path.posix.basename(f, ".json");
		const local = read(there(f)) as string;
		if (!isObject(json(local))) continue;
		const vault = read(live(f));
		if (vault === null) {
			await put(f, local);
			report.sessions.added++;
			continue;
		}
		if (vault === local) {
			report.sessions.identical++;
			continue;
		}
		const lm = messagesOf(json(local));
		const vm = messagesOf(json(vault));
		if (lm && vm && isPrefix(lm, vm)) {
			report.sessions.keptVault++;
		} else if (lm && vm && isPrefix(vm, lm)) {
			await put(f, local);
			report.sessions.continued++;
		} else {
			const existing = names(path.join(o.dataDir, "chats")).filter((n) => n.startsWith(`${id}.sync-conflict-`));
			if (existing.some((n) => read(path.join(o.dataDir, "chats", n)) === local)) continue;
			writeFileAtomic(freePath(path.join(o.dataDir, "chats", `${id}.sync-conflict-${s.date}-${s.time}-${tag}.json`)), local);
			report.sessions.conflictCopies++;
		}
	}
	// conflict copies the learner already had keep their place, when their session is there
	for (const f of files.filter((x) => /^chats\/[^/]+\.sync-conflict-[A-Za-z0-9-]+\.json$/.test(x))) {
		const id = path.posix.basename(f).split(".sync-conflict-")[0] as string;
		if (!fs.existsSync(live(`chats/${id}.json`)) || fs.existsSync(live(f))) continue;
		writeFileAtomic(live(f), read(there(f)) as string);
	}

	// ── jobs
	for (const f of files.filter((x) => /^jobs\/[^/]+\.json$/.test(x))) {
		const local = read(there(f)) as string;
		const job = json(local);
		if (!isObject(job) || typeof job.chatId !== "string" || !fs.existsSync(live(`chats/${job.chatId}.json`))) {
			report.jobs.skipped++;
			continue;
		}
		const vault = read(live(f));
		if (vault === null) {
			await put(f, local);
			report.jobs.added++;
		} else if (vault === local) report.jobs.identical++;
		else {
			setAside(f, local);
			report.jobs.keptVault++;
		}
	}

	// ── prompts
	for (const f of files.filter((x) => x.startsWith("prompts/") && !CONFLICT_RE.test(x))) {
		const local = read(there(f)) as string;
		const vault = read(live(f));
		if (f === "prompts/switches.json") {
			const a = json(local);
			const b = json(vault);
			if (!isObject(a)) continue;
			const merged: Record<string, boolean> = {};
			for (const src of [isObject(b) ? b : {}, a]) for (const [k, v] of Object.entries(src)) if (typeof v === "boolean") merged[k] = (merged[k] ?? false) || v;
			const text = JSON.stringify(merged, null, "\t");
			if (vault === null || JSON.stringify(json(vault)) !== JSON.stringify(merged)) {
				await put(f, text);
				report.prompts.switchesMerged = true;
			} else report.prompts.identical++;
			continue;
		}
		if (vault === null) {
			await put(f, local);
			report.prompts.added++;
		} else if (vault === local) report.prompts.identical++;
		else {
			setAside(f, local);
			report.prompts.keptVault++;
		}
	}

	// ── sources: add the entries the vault lacks
	if (files.includes("graph/sources.json")) {
		const a = json(read(there("graph/sources.json")));
		const b = json(read(live("graph/sources.json")));
		if (isObject(a)) {
			const merged: Record<string, unknown> = isObject(b) ? { ...b } : {};
			let added = 0;
			for (const [k, v] of Object.entries(a)) if (!(k in merged)) (merged[k] = v, added++);
			if (added > 0 || b === undefined) {
				await put("graph/sources.json", JSON.stringify(merged, null, "\t"));
				report.sources.added = added;
			}
		}
	}

	// ── graph ledgers: lines the vault lacks go to this device's own files
	const kinds = ["nodes", "chains", "sessions", "coverage", "deletions"] as const;
	for (const kind of kinds) {
		const mine = files.filter((f) => {
			const m = LEDGER_RE.exec(f);
			return m !== null && m[1] === kind && (m[2] === undefined || m[2] === o.deviceId);
		});
		report.leftBehind.push(...files.filter((f) => {
			const m = LEDGER_RE.exec(f);
			return m !== null && m[1] === kind && m[2] !== undefined && m[2] !== o.deviceId;
		}));
		if (mine.length === 0) continue;
		const liveFiles = names(path.join(o.dataDir, "graph"))
			.map((n) => `graph/${n}`)
			.filter((f) => {
				const m = LEDGER_RE.exec(f);
				return m !== null && m[1] === kind;
			});
		/** A line's identity: the line itself, but a node line counts the same with or without its link mark. */
		const keyOf = (line: string): string => {
			if (kind !== "nodes") return line;
			const n = json(line);
			if (!isObject(n) || n.link !== true) return line;
			const { link: _link, ...rest } = n;
			return JSON.stringify(rest);
		};
		const have = new Set<string>();
		const nodeIds = new Set<string>();
		for (const lf of liveFiles) {
			for (const line of (read(live(lf)) ?? "").split("\n")) {
				if (!line.trim()) continue;
				have.add(keyOf(line));
				if (kind === "nodes") {
					const n = json(line);
					if (isObject(n) && typeof n.id === "string") nodeIds.add(n.id);
				}
			}
		}
		const out: string[] = [];
		for (const f of mine) {
			for (const line of (read(there(f)) ?? "").split("\n")) {
				if (!line.trim() || have.has(keyOf(line))) continue;
				have.add(keyOf(line));
				let text = line;
				if (kind === "nodes") {
					const n = json(line);
					if (isObject(n) && typeof n.id === "string") {
						if (nodeIds.has(n.id) && n.link !== true) {
							text = JSON.stringify({ ...n, link: true });
							report.graphLines.linked++;
						}
						nodeIds.add(n.id);
					}
				}
				out.push(text);
			}
		}
		if (out.length === 0) continue;
		const ownRel = `graph/${kind}.${o.deviceId}.jsonl`;
		const ownFile = live(ownRel);
		const size = fs.existsSync(ownFile) ? fs.statSync(ownFile).size : 0;
		const torn = size > 0 && (fs.readFileSync(ownFile).at(-1) !== 0x0a);
		await o.sink.noteLedgerAppended(ownRel, size);
		fs.mkdirSync(path.dirname(ownFile), { recursive: true });
		fs.appendFileSync(ownFile, `${torn ? "\n" : ""}${out.join("\n")}\n`);
		report.graphLines.added += out.length;
		changedPaths.push(ownRel);
	}
	o.changed?.(changedPaths);
	writeFileAtomic(path.join(o.localDir, "migration", `merge-${path.basename(o.fromDir)}.json`), JSON.stringify(report, null, "\t"));
	return report;
}

/** The moved-aside folders a device holds, newest first, with what a merge would look at. */
export function listMovedAside(localDir: string): MovedAsideDto[] {
	let names: string[];
	try {
		names = fs.readdirSync(localDir).filter((n) => /^pre-vault-\d{8}(-\d+)?$/.test(n));
	} catch {
		return [];
	}
	return names
		.sort()
		.reverse()
		.map((name) => {
			const files = walk(path.join(localDir, name));
			return {
				name,
				sessions: files.filter((f) => /^chats\/[^/]+\.json$/.test(f) && !CONFLICT_RE.test(f)).length,
				files: files.length,
				merged: fs.existsSync(path.join(localDir, "migration", `merge-${name}.json`)),
			};
		});
}
