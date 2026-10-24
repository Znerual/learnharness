/**
 * THE OBSIDIAN INTEGRATION (obsidian wave, owner 2026-10-24) — both
 * directions against the vault named by settings `graph.obsidianVault`
 * (null = off).
 *
 * EXPORT (graph → vault, automatic): core/obsidian-export.ts renders one
 * note per birth session; this module writes them under
 * <vault>/LearnHarness/ (app-owned — owner ruling) and deletes stale
 * notes there, but ONLY files carrying the `lh_export: true` marker, so a
 * hand-made file in the folder survives. Files whose content is unchanged
 * are not rewritten. Triggered 3 s after the last graph-relevant signal:
 * the activity feed (extraction merges), the session list (titles,
 * deletes), a node delete, and a vault-path save.
 *
 * SYNC (vault → graph, manual): scans every .md in the vault except the
 * export folder, Obsidian's own folders and sync-conflict copies, and
 * runs each NEW or CHANGED file (sha256 vs the source's vaultFp) through
 * the notes front door with its vault-relative path, three at a time
 * (the extract semaphore throttles further). A completed import stamps
 * the fingerprint; a failed or partial one is retried next Sync. Notes
 * deleted from the vault keep their propositions (owner ruling).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { subscribe } from "../core/events.ts";
import { graphSnapshot } from "../core/graph.ts";
import { OBSIDIAN_EXPORT_DIR, OBSIDIAN_EXPORT_MARKER, renderObsidianExport } from "../core/obsidian-export.ts";
import type { EmissionStats } from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { notesSourceId } from "../agent/subagents/extraction.ts";
import { effectiveSettings, stores } from "./stores.ts";

const EXPORT_DEBOUNCE_MS = 3_000;
const SYNC_WORKERS = 3;

/** The configured vault, or null when the integration is off or the
 *  directory vanished since it was saved. */
export function obsidianVault(): string | null {
	const vault = effectiveSettings().graph.obsidianVault;
	if (!vault) return null;
	try {
		return fs.statSync(vault).isDirectory() ? vault : null;
	} catch {
		return null;
	}
}

/** Is `dir` an existing directory? (the vault-path PUT's check) */
export function isExistingDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

// ─── export ──────────────────────────────────────────────────────────────────

export interface ObsidianExportStats {
	written: number;
	unchanged: number;
	deleted: number;
}

/** Every .md under `dir`, recursively (absolute paths). */
function markdownFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return markdownFiles(full);
		return e.isFile() && e.name.toLowerCase().endsWith(".md") ? [full] : [];
	});
}

/** Does this file carry the export marker in its frontmatter? */
function isExportedNote(file: string): boolean {
	try {
		const head = fs.readFileSync(file, "utf-8").slice(0, 512);
		return head.startsWith("---\n") && head.split("\n---")[0]!.split("\n").includes(OBSIDIAN_EXPORT_MARKER);
	} catch {
		return false;
	}
}

/** Write the export into `vault` now. Exported for tests and the
 *  scheduler; callers outside tests use scheduleObsidianExport(). */
export function writeObsidianExport(vault: string): ObsidianExportStats {
	const snapshot = graphSnapshot(stores);
	const files = renderObsidianExport(snapshot);
	const stats: ObsidianExportStats = { written: 0, unchanged: 0, deleted: 0 };
	const keep = new Set<string>();
	for (const file of files) {
		const full = path.join(vault, file.relPath);
		keep.add(full);
		let current: string | null = null;
		try {
			current = fs.readFileSync(full, "utf-8");
		} catch {
			// new note
		}
		if (current === file.content) {
			stats.unchanged++;
			continue;
		}
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, file.content, "utf-8");
		stats.written++;
	}
	for (const file of markdownFiles(path.join(vault, OBSIDIAN_EXPORT_DIR))) {
		if (keep.has(file) || !isExportedNote(file)) continue;
		fs.rmSync(file);
		stats.deleted++;
	}
	return stats;
}

interface ExportState {
	timer?: ReturnType<typeof setTimeout>;
	subscribed: boolean;
}
const EXPORT_KEY = Symbol.for("lh.obsidianExport");
function exportState(): ExportState {
	const g = globalThis as Record<symbol, ExportState | undefined>;
	if (!g[EXPORT_KEY]) g[EXPORT_KEY] = { subscribed: false };
	return g[EXPORT_KEY];
}

/** Export 3 s after the last call (debounced); a no-op with no vault. */
export function scheduleObsidianExport(): void {
	const state = exportState();
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		state.timer = undefined;
		const vault = obsidianVault();
		if (!vault) return;
		try {
			const stats = writeObsidianExport(vault);
			if (stats.written || stats.deleted) {
				console.info(`[obsidian] export: ${stats.written} written, ${stats.deleted} deleted, ${stats.unchanged} unchanged`);
			}
		} catch (err) {
			console.error("[obsidian] export failed:", err);
		}
	}, EXPORT_DEBOUNCE_MS);
	state.timer.unref?.();
}

/** Wire the automatic export to the event bus — once per process (HMR
 *  re-imports must not stack listeners). Tests never start it. */
export function startObsidianExportTriggers(): void {
	const state = exportState();
	if (state.subscribed || process.env.NODE_ENV === "test") return;
	state.subscribed = true;
	subscribe((event) => {
		if (event.type === "activity-changed" || event.type === "chats-changed") scheduleObsidianExport();
	});
	scheduleObsidianExport(); // catch up on whatever changed while the app was closed
}

// ─── sync ────────────────────────────────────────────────────────────────────

/** Folders and files the Sync never imports. */
function isExcludedFromSync(relPath: string): boolean {
	const parts = relPath.split("/");
	const top = parts[0] ?? "";
	if (top === OBSIDIAN_EXPORT_DIR || top === ".trash" || top.startsWith(".obsidian")) return true;
	if (parts.some((p) => p.startsWith("."))) return true; // hidden folders (.stfolder, .git, …)
	return /\.sync-conflict-/.test(parts[parts.length - 1] ?? "");
}

/** One vault note the Sync would import. */
export interface VaultNote {
	/** Vault-relative, forward slashes — the notes source's filePath. */
	relPath: string;
	text: string;
	fp: string;
}

/** Scan the vault: every importable, non-empty note with its fingerprint. */
export function scanVault(vault: string): VaultNote[] {
	const notes: VaultNote[] = [];
	for (const full of markdownFiles(vault)) {
		const relPath = path.relative(vault, full).split(path.sep).join("/");
		if (isExcludedFromSync(relPath)) continue;
		const text = fs.readFileSync(full, "utf-8");
		if (!text.trim()) continue;
		notes.push({ relPath, text, fp: crypto.createHash("sha256").update(text).digest("hex") });
	}
	return notes.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
}

/** The notes that need importing: new, or changed since their last
 *  completed Sync import. */
export function notesToSync(notes: readonly VaultNote[]): VaultNote[] {
	const synced = new Map(stores.graphStore.readSources().map((s) => [s.id, s.vaultFp]));
	return notes.filter((n) => synced.get(notesSourceId(n.relPath)) !== n.fp);
}

export interface VaultSyncStatus {
	running: boolean;
	total: number;
	skipped: number;
	done: number;
	failed: number;
	/** The run-ending refusal (models or key missing), when one stopped it. */
	error?: string;
}

const SYNC_KEY = Symbol.for("lh.obsidianSync");
function syncState(): { status: VaultSyncStatus } {
	const g = globalThis as Record<symbol, { status: VaultSyncStatus } | undefined>;
	if (!g[SYNC_KEY]) g[SYNC_KEY] = { status: { running: false, total: 0, skipped: 0, done: 0, failed: 0 } };
	return g[SYNC_KEY];
}

export function vaultSyncStatus(): VaultSyncStatus {
	return { ...syncState().status };
}

export type ImportNotesFn = (input: { filePath: string; text: string }) => Promise<EmissionStats>;

/**
 * Start a Sync in the background. Returns the starting status, or null
 * when one is already running. `importNotes` is the extraction front
 * door (injected — the route passes the app's pipeline; tests a fake).
 * The returned promise-free API is deliberate: the route answers 202 and
 * progress shows in the status chips + GET status.
 */
export function startVaultSync(
	vault: string,
	importNotes: ImportNotesFn,
): { status: VaultSyncStatus; finished: Promise<void> } | null {
	const state = syncState();
	if (state.status.running) return null;
	const all = scanVault(vault);
	const queue = notesToSync(all);
	state.status = { running: true, total: queue.length, skipped: all.length - queue.length, done: 0, failed: 0 };
	const status = { ...state.status };
	let stop = false;
	const worker = async () => {
		for (;;) {
			if (stop) return;
			const note = queue.shift();
			if (!note) return;
			try {
				await importNotes({ filePath: note.relPath, text: note.text });
				const id = notesSourceId(note.relPath);
				const source = stores.graphStore.readSources().find((s) => s.id === id);
				if (source) stores.graphStore.upsertSource({ ...source, vaultFp: note.fp });
				state.status.done++;
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
					state.status.error = err.message;
					stop = true;
					return;
				}
				state.status.failed++;
				console.error(`[obsidian] sync: ${note.relPath} failed:`, err instanceof Error ? err.message : err);
			}
		}
	};
	console.info(`[obsidian] sync start: ${queue.length} to import, ${status.skipped} unchanged`);
	const finished = Promise.all(Array.from({ length: Math.min(SYNC_WORKERS, queue.length) }, worker)).then(() => {
		state.status.running = false;
		console.info(`[obsidian] sync done: ${state.status.done} imported, ${state.status.failed} failed`);
		scheduleObsidianExport();
	});
	return { status, finished };
}

// Arm the automatic export at first import (idempotent; the barrel loads
// this module on every route path — the keys seam's initAuthEnv pattern).
startObsidianExportTriggers();
