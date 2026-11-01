/**
 * The DATA FOLDER UPGRADE before the vault (docs/vault-migration.md): brings a data folder written
 * by any supported older build (upstream 0.3.0 to 0.4.1, the fork before and after its multi-device
 * split) to the format the vault syncs, without losing anything.
 *
 * - `scanDataFolder` is the dry run: it reads, it never writes, and it names what each step would do.
 * - `upgradeDataFolder` takes a backup into the device-local folder first (never inside the data
 *   folder), then runs the steps in order. Every step is derived from what is on disk, so it is
 *   idempotent, and each one is journaled (`<local>/migration/journal.json`, written by temp file and
 *   rename), so a crash midway resumes with the same backup and finishes on the next run.
 * - Nothing is deleted. Files that do not belong in a synced folder move to
 *   `<local>/migration/set-aside/<run>/` or `<local>/conflicts/`; the backup holds the rest.
 *
 * No vault client and no PATHS here: every function takes the two folders, so tests run it on
 * fixture folders and the vault runtime runs it on the live ones.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { CURRENT_CHAT_VERSION, CURRENT_GRAPH_FORMAT_VERSION } from "../../core/contracts.ts";
import { deviceLocalMoves } from "../../store/local-migration.ts";
import { moveFile, writeFileAtomic } from "../../store/fs-files.ts";
import type { ConflictItem, MigrationReport, PlannedStep, StepId } from "../../core/vault/migration.ts";
import { findSyncthingMarkers } from "../vault/syncthing.ts";

export type { ConflictItem, MigrationReport, PlannedStep, StepId };

export interface MigrationPaths {
	/** The synced data folder (PATHS.data). */
	dataDir: string;
	/** The device-local folder (PATHS.local). Must be outside the data folder. */
	localDir: string;
}

export interface MigrationDevice {
	id: string;
	name: string;
}

export interface UpgradeResult {
	report: MigrationReport;
	/** Steps that changed something in this call. */
	ran: StepId[];
	backupDir: string | null;
	setAsideDir: string | null;
}

export class MigrationRefusedError extends Error {
	readonly code = "data_newer";
	constructor(readonly paths: string[]) {
		super(`This data was saved by a newer LearnHarness (${paths.join(", ")}). Update the app first; nothing was changed.`);
		this.name = "MigrationRefusedError";
	}
}

export interface UpgradeOptions {
	/** This device, for jobs that were running when the older build stopped. */
	device: MigrationDevice;
	now?: () => Date;
	/** Test hook: called after each step is journaled; throwing simulates a crash. */
	afterStep?: (id: StepId) => void;
	/** Test hook: called after the backup copy, before it is renamed into place. */
	afterBackupCopy?: () => void;
}

// ─────────────────────────────────────────────────────────────── file listing

const BASE_LEDGERS = ["nodes", "chains", "sessions", "coverage"] as const;
/** Ledger-like files of builds before 0.3.0 that nothing reads. The vault client would seed a `.jsonl` here as a shared ledger. */
const DEAD_GRAPH_FILES = ["edges.jsonl", "events.jsonl", "mappings.jsonl", "naming-runs.jsonl", "cluster-labels.jsonl", "embeddings.json"];
const CONFLICT_RE = /^(.*)\.sync-conflict-\d{8}-\d{6}-[A-Za-z0-9-]+(\.[^./]*)?$/;
const TORN_RE = /\.tmp-[0-9a-f]{8}$|^\.syncthing\..*\.tmp$|^~syncthing~.*\.tmp$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Every file under the folder, POSIX-relative, without Syncthing's own folders. */
function walk(root: string, skip: (rel: string) => boolean = () => false): string[] {
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
			if (e.name === ".stversions" || e.name === ".stfolder" || skip(r)) continue;
			if (e.isDirectory()) visit(path.join(dir, e.name), r);
			else if (e.isFile()) out.push(r);
		}
	};
	visit(root, "");
	return out;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** A path that does not exist yet: `p`, else `p.2`, `p.3`, ... (a move must never replace a file). */
function freePath(p: string): string {
	if (!fs.existsSync(p)) return p;
	for (let i = 2; ; i++) if (!fs.existsSync(`${p}.${i}`)) return `${p}.${i}`;
}

// ─────────────────────────────────────────────────────────────── what is in the folder

interface Inventory {
	files: string[];
	sessions: string[];
	jobs: string[];
	conflicts: ConflictItem[];
	unreadable: string[];
	newer: string[];
	graphFormat: number | null;
	hasGraphData: boolean;
}

function inventory(p: MigrationPaths): Inventory {
	const files = walk(p.dataDir);
	const present = new Set(files);
	const sessions: string[] = [];
	const jobs: string[] = [];
	const conflicts: ConflictItem[] = [];
	const unreadable: string[] = [];
	const newer: string[] = [];
	for (const f of files) {
		const base = path.posix.basename(f);
		const c = CONFLICT_RE.exec(base);
		if (c) {
			const dir = path.posix.dirname(f);
			const original = (c[1] as string) + (c[2] ?? "");
			if (dir === "chats" && c[2] === ".json" && ID_RE.test(c[1] as string)) {
				const orig = `chats/${original}`;
				const promotable = !present.has(orig) && isObject(readJson(path.join(p.dataDir, f)));
				conflicts.push({ path: f, kind: "session", action: present.has(orig) ? "keep" : promotable ? "promote" : "set-aside" });
			} else if (dir === "graph" && c[2] === ".jsonl" && (BASE_LEDGERS as readonly string[]).includes(c[1] as string)) {
				conflicts.push({ path: f, kind: "base-ledger", action: "merge-lines" });
			} else conflicts.push({ path: f, kind: "other", action: "set-aside" });
			continue;
		}
		if (TORN_RE.test(base)) continue;
		if (/^chats\/[^/]+\.json$/.test(f) || /^jobs\/[^/]+\.json$/.test(f)) {
			const parsed = readJson(path.join(p.dataDir, f));
			if (!isObject(parsed)) {
				unreadable.push(f);
				continue;
			}
			if (f.startsWith("chats/")) {
				sessions.push(f);
				if (typeof parsed.version === "number" && parsed.version > CURRENT_CHAT_VERSION) newer.push(f);
			} else jobs.push(f);
		}
	}
	const format = readJson(path.join(p.dataDir, "graph", "format.json"));
	const graphFormat = isObject(format) && typeof format.version === "number" && Number.isInteger(format.version) ? format.version : null;
	if (graphFormat !== null && graphFormat > CURRENT_GRAPH_FORMAT_VERSION) newer.push("graph/format.json");
	const hasGraphData = files.some((f) => /^graph\/[^/]+\.jsonl$/.test(f) || f === "graph/sources.json" || f === "graph/format.json");
	return { files, sessions, jobs, conflicts, unreadable, newer, graphFormat, hasGraphData };
}

// ─────────────────────────────────────────────────────────────── the steps

interface Ctx {
	p: MigrationPaths;
	inv: Inventory;
	device: MigrationDevice;
	setAsideDir: string;
}

interface Step {
	id: StepId;
	title: string;
	plan(c: Pick<Ctx, "p" | "inv">): string[];
	run(c: Ctx): void;
}

function moveAside(c: Ctx, rel: string, from: string): void {
	moveFile(from, freePath(path.join(c.setAsideDir, rel)));
}

function legacyLocalPending(p: MigrationPaths): { from: string; to: string; stale: boolean }[] {
	return deviceLocalMoves(p.dataDir, p.localDir).flatMap(([from, to]) => (fs.existsSync(from) ? [{ from, to, stale: fs.existsSync(to) }] : []));
}

const rel = (p: MigrationPaths, f: string) => path.relative(p.dataDir, f).split(path.sep).join("/");

const STEPS: Step[] = [
	{
		id: "local-split",
		title: "Move settings, graph layout and debug files out of the synced folder",
		plan: ({ p }) => legacyLocalPending(p).map((m) => rel(p, m.from)),
		run(c) {
			for (const m of legacyLocalPending(c.p)) {
				// The device-local twin is authoritative: a legacy copy next to it is a stale leftover.
				if (m.stale) moveAside(c, rel(c.p, m.from), m.from);
				else moveFile(m.from, m.to);
			}
		},
	},
	{
		id: "prompt-switches",
		title: "Move prompt switches next to the prompt files",
		plan: ({ p }) => (promptSwitchesIn(p) ? ["prompts/switches.json"] : []),
		run(c) {
			const settingsFile = path.join(c.p.localDir, "settings.json");
			const settings = readJson(settingsFile);
			if (!isObject(settings) || !isObject(settings.agent) || !isObject(settings.agent.prompts)) return;
			const switchesFile = path.join(c.p.dataDir, "prompts", "switches.json");
			const current = readJson(switchesFile);
			const merged: Record<string, boolean> = {};
			if (isObject(current)) for (const [k, v] of Object.entries(current)) if (typeof v === "boolean") merged[k] = v;
			// A switch that is on in either place stays on (the rule of migratePromptSwitches).
			for (const [k, v] of Object.entries(settings.agent.prompts)) if (typeof v === "boolean") merged[k] = (merged[k] ?? false) || v;
			writeFileAtomic(switchesFile, JSON.stringify(merged, null, "\t"));
			const { prompts: _moved, ...agent } = settings.agent;
			writeFileAtomic(settingsFile, JSON.stringify({ ...settings, agent }, null, "\t"));
		},
	},
	{
		id: "stray-files",
		title: "Set aside torn writes, unreadable records and files no build reads any more",
		plan: ({ inv }) => strayFiles(inv),
		run(c) {
			for (const f of strayFiles(c.inv)) moveAside(c, f, path.join(c.p.dataDir, f));
		},
	},
	{
		id: "conflicts",
		title: "Sort Syncthing conflict copies",
		plan: ({ inv }) => inv.conflicts.filter((x) => x.action !== "keep").map((x) => x.path),
		run(c) {
			const conflictsDir = path.join(c.p.localDir, "conflicts");
			for (const item of scanConflicts(c.p)) {
				const file = path.join(c.p.dataDir, item.path);
				if (item.action === "keep") continue;
				if (item.action === "promote") {
					const base = path.posix.basename(item.path);
					const m = CONFLICT_RE.exec(base) as RegExpExecArray;
					fs.renameSync(file, path.join(path.dirname(file), `${m[1]}.json`));
					continue;
				}
				if (item.action === "merge-lines") mergeLedgerLines(c.p, item.path);
				moveFile(file, freePath(path.join(conflictsDir, item.path)));
			}
		},
	},
	{
		id: "graph-format",
		title: "Stamp the knowledge map as format 2",
		plan: ({ inv }) => (inv.hasGraphData && (inv.graphFormat ?? 1) < CURRENT_GRAPH_FORMAT_VERSION ? ["graph/format.json"] : []),
		run(c) {
			const inv = inventory(c.p);
			if (!inv.hasGraphData || (inv.graphFormat ?? 1) >= CURRENT_GRAPH_FORMAT_VERSION) return;
			writeFileAtomic(path.join(c.p.dataDir, "graph", "format.json"), JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t") + "\n");
		},
	},
	{
		id: "job-owner",
		title: "Mark jobs that were still running as this device's",
		plan: ({ p, inv }) => inv.jobs.filter((f) => ownerless(p, f)),
		run(c) {
			for (const f of inventory(c.p).jobs.filter((x) => ownerless(c.p, x))) {
				const file = path.join(c.p.dataDir, f);
				const job = readJson(file) as Record<string, unknown>;
				writeFileAtomic(file, JSON.stringify({ ...job, deviceId: c.device.id, deviceName: c.device.name }, null, "\t"));
			}
		},
	},
];

/** A job a build stopped in the middle of has no owning device, so every other device would read it as its own. */
function ownerless(p: MigrationPaths, f: string): boolean {
	const job = readJson(path.join(p.dataDir, f));
	return isObject(job) && job.status === "running" && job.deviceId === undefined;
}

/** The settings record that still holds the switches: the device-local one, or the legacy one the split step is about to move there. */
function promptSwitchesIn(p: MigrationPaths): boolean {
	const local = path.join(p.localDir, "settings.json");
	const settings = readJson(fs.existsSync(local) ? local : path.join(p.dataDir, "settings.json"));
	return isObject(settings) && isObject(settings.agent) && isObject(settings.agent.prompts);
}

function strayFiles(inv: Inventory): string[] {
	const out = new Set<string>();
	for (const f of inv.files) {
		const base = path.posix.basename(f);
		if (TORN_RE.test(base) && !CONFLICT_RE.test(base)) out.add(f);
		if (DEAD_GRAPH_FILES.some((d) => f === `graph/${d}`)) out.add(f);
		if (f.startsWith("legacy-graph/")) out.add(f);
	}
	for (const f of inv.unreadable) out.add(f);
	return [...out].sort();
}

function scanConflicts(p: MigrationPaths): ConflictItem[] {
	return inventory(p).conflicts;
}

/** Adds the lines the shared ledger lacks, in the copy's order (a ledger is a set of JSON lines). */
function mergeLedgerLines(p: MigrationPaths, conflictRel: string): void {
	const m = CONFLICT_RE.exec(path.posix.basename(conflictRel)) as RegExpExecArray;
	const mainFile = path.join(p.dataDir, "graph", `${m[1]}.jsonl`);
	const main = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, "utf-8") : "";
	const have = new Set(main.split("\n").filter((l) => l.trim()));
	const extra = fs
		.readFileSync(path.join(p.dataDir, conflictRel), "utf-8")
		.split("\n")
		.filter((l) => l.trim() && !have.has(l));
	if (extra.length === 0) return;
	const head = main === "" || main.endsWith("\n") ? main : `${main}\n`;
	writeFileAtomic(mainFile, `${head}${extra.join("\n")}\n`);
}

// ─────────────────────────────────────────────────────────────── scan (the dry run)

/** What `upgradeDataFolder` would do. Reads only. */
export function scanDataFolder(p: MigrationPaths): MigrationReport {
	const inv = inventory(p);
	const ctx = { p, inv };
	const steps: PlannedStep[] = STEPS.flatMap((s) => {
		const files = s.plan(ctx);
		return files.length > 0 ? [{ id: s.id, title: s.title, files: files.length, examples: files.slice(0, 3) }] : [];
	});
	const ledgerFiles = inv.files.filter((f) => /^graph\/[a-z][a-z0-9_-]*(\.dev_[a-z0-9]{8})?\.jsonl$/.test(f)).length;
	const empty = inv.files.length === 0;
	const older = steps.some((s) => s.id === "local-split") || ((inv.graphFormat ?? 1) < CURRENT_GRAPH_FORMAT_VERSION && inv.hasGraphData);
	return {
		layout: empty ? "empty" : older ? "older" : "current",
		graphFormat: inv.graphFormat,
		counts: {
			sessions: inv.sessions.length,
			jobs: inv.jobs.length,
			ledgerFiles,
			prompts: inv.files.filter((f) => f.startsWith("prompts/")).length,
			conflicts: inv.conflicts.length,
		},
		steps: steps.length > 0 ? [{ id: "backup", title: "Back up this folder to the device-local folder", files: inv.files.length, examples: [] }, ...steps] : [],
		conflicts: inv.conflicts,
		unreadable: inv.unreadable,
		blocked: inv.newer.length > 0 ? { reason: "data_newer", paths: inv.newer } : null,
		syncthing: findSyncthingMarkers(p.dataDir).map((m) => m.path),
		needed: steps.length > 0,
	};
}

// ─────────────────────────────────────────────────────────────── journal and backup

interface Journal {
	version: 1;
	runId: string;
	startedAt: string;
	backupDir: string;
	backupDone: boolean;
	steps: Partial<Record<StepId, { at: string }>>;
	finishedAt?: string;
}

const journalFile = (p: MigrationPaths) => path.join(p.localDir, "migration", "journal.json");

export function readJournal(p: MigrationPaths): Journal | null {
	const j = readJson(journalFile(p));
	return isObject(j) && j.version === 1 && typeof j.runId === "string" ? (j as unknown as Journal) : null;
}

function writeJournal(p: MigrationPaths, j: Journal): void {
	writeFileAtomic(journalFile(p), JSON.stringify(j, null, "\t"));
}

const BACKUP_SKIP = (r: string): boolean => r === "debug" || r.startsWith("debug/");

/** Copies the folder (and the device-local files the steps touch) to `<local>/backups/migration-<run>/`. Temp folder, then rename. */
function takeBackup(p: MigrationPaths, final: string, hook?: () => void): void {
	if (fs.existsSync(final)) return;
	const tmp = `${final}.partial`;
	fs.rmSync(tmp, { recursive: true, force: true });
	for (const f of walk(p.dataDir, BACKUP_SKIP)) {
		const to = path.join(tmp, "data", f);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(path.join(p.dataDir, f), to);
	}
	for (const name of ["settings.json", "positions.json", "render-settings.json", "device.json"]) {
		const from = path.join(p.localDir, name);
		if (!fs.existsSync(from)) continue;
		fs.mkdirSync(path.join(tmp, "local"), { recursive: true });
		fs.copyFileSync(from, path.join(tmp, "local", name));
	}
	fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
	hook?.();
	fs.renameSync(tmp, final);
}

// ─────────────────────────────────────────────────────────────── upgrade

/**
 * Backs up, then runs every pending step. Safe to call again at any time: finished work is not
 * redone, an interrupted run resumes with its own backup, and a folder with nothing to do is not touched
 * (no backup, no journal entry). Throws `MigrationRefusedError` for data saved by a newer build.
 */
export function upgradeDataFolder(p: MigrationPaths, o: UpgradeOptions): UpgradeResult {
	if (inside(p.dataDir, p.localDir)) throw new Error("The device-local folder must be outside the data folder.");
	const now = o.now ?? (() => new Date());
	const before = scanDataFolder(p);
	if (before.blocked) throw new MigrationRefusedError(before.blocked.paths);
	const prior = readJournal(p);
	const resumable = prior !== null && prior.finishedAt === undefined;
	if (!before.needed && !resumable) return { report: before, ran: [], backupDir: null, setAsideDir: null };

	const runId = resumable ? (prior as Journal).runId : stamp(now());
	const backupDir = path.join(p.localDir, "backups", `migration-${runId}`);
	const setAsideDir = path.join(p.localDir, "migration", "set-aside", runId);
	const journal: Journal = resumable
		? (prior as Journal)
		: { version: 1, runId, startedAt: now().toISOString(), backupDir, backupDone: false, steps: {} };
	writeJournal(p, journal);

	if (!journal.backupDone) {
		takeBackup(p, backupDir, o.afterBackupCopy);
		journal.backupDone = true;
		writeJournal(p, journal);
	}
	const ran: StepId[] = [];
	for (const step of STEPS) {
		const inv = inventory(p);
		const pending = step.plan({ p, inv }).length > 0;
		if (pending) {
			step.run({ p, inv, device: o.device, setAsideDir });
			ran.push(step.id);
		}
		journal.steps[step.id] = { at: now().toISOString() };
		writeJournal(p, journal);
		o.afterStep?.(step.id);
	}
	journal.finishedAt = now().toISOString();
	writeJournal(p, journal);
	return { report: scanDataFolder(p), ran, backupDir, setAsideDir: fs.existsSync(setAsideDir) ? setAsideDir : null };
}
