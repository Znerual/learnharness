/**
 * THE OBSIDIAN EXPORT RENDERER (obsidian wave, owner 2026-10-24): the
 * graph → vault direction, as pure data. One note per birth session
 * (owner ruling): every teaching session becomes
 * `LearnHarness/Sessions/<title>.md`, every imported notes file
 * `LearnHarness/Notes/<original basename>.md` with a link back to the
 * original vault note. Inside a note each proposition born there is a
 * heading; each chain sits under its conclusion's heading, its premises
 * as heading links — `[[#A]]` within the note, `[[<other note>#B]]`
 * across sessions — so Obsidian's graph links sessions that share
 * reasoning (owner ruling: heading links).
 *
 * PURE — no fs. The writer (src/server/obsidian.ts) owns the folder: it
 * writes these files and deletes stale ones carrying the
 * `lh_export: true` marker. Output is deterministic for a given graph
 * (stable ordering, no wall-clock), so an unchanged graph rewrites
 * nothing.
 */

import type { GraphChain, GraphNode } from "./contracts.ts";
import { birthSessionOf } from "./session-clusters.ts";

/** The app-owned folder inside the vault. */
export const OBSIDIAN_EXPORT_DIR = "LearnHarness";
/** The frontmatter marker the writer requires before deleting a file. */
export const OBSIDIAN_EXPORT_MARKER = "lh_export: true";

/** The slice of the graph snapshot the export reads. */
export interface ObsidianExportInput {
	propositions: readonly GraphNode[];
	chains: readonly GraphChain[];
	/** chatId → session title. */
	sessions: Readonly<Record<string, string>>;
	/** srcId → the imported file's path (vault-relative for synced notes). */
	fileSources: Readonly<Record<string, string>>;
}

/** One file to write, path relative to the vault root. */
export interface ObsidianExportFile {
	relPath: string;
	content: string;
}

/** Characters Obsidian (or the filesystems it syncs to) refuse in a note
 *  name, or that break `[[links]]`. */
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

/** A safe note basename (no extension): forbidden characters dropped,
 *  whitespace collapsed, ≤ 120 chars, never empty. */
export function sanitizeNoteName(raw: string): string {
	const cleaned = raw.replace(FORBIDDEN_NAME_CHARS, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120).trim();
	return cleaned || "Untitled";
}

/** A heading text a `[[Note#Heading]]` link can target: link-breaking
 *  characters dropped, whitespace collapsed, never empty. */
export function sanitizeHeading(raw: string): string {
	const cleaned = raw.replace(/[#|^[\]%]/g, " ").replace(/:/g, " -").replace(/\s+/g, " ").trim();
	return cleaned || "Untitled";
}

/** The link target of an imported file: its path without ".md" (Obsidian
 *  resolves vault-relative paths). */
function noteLinkTarget(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
}

function basenameOf(filePath: string): string {
	const parts = filePath.replace(/\\/g, "/").split("/");
	return (parts[parts.length - 1] ?? filePath).replace(/\.md$/i, "");
}

interface PlannedNote {
	sessionId: string;
	kind: "session" | "notes";
	title: string;
	/** Vault-relative path WITHOUT ".md" — the link target. */
	target: string;
	sourcePath?: string;
	members: GraphNode[];
}

const byCreatedThenId = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
	a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Plan one note per birth session: title, folder, clash-free name. */
function planNotes(input: ObsidianExportInput): PlannedNote[] {
	const members = new Map<string, GraphNode[]>();
	for (const node of input.propositions) {
		const birth = birthSessionOf(node);
		if (birth === null) continue; // no provenance — belongs to no session
		const bucket = members.get(birth);
		if (bucket) bucket.push(node);
		else members.set(birth, [node]);
	}
	const planned: PlannedNote[] = [];
	for (const [sessionId, nodes] of [...members.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const sourcePath = input.fileSources[sessionId];
		const kind = sourcePath !== undefined ? "notes" : "session";
		const title = kind === "notes" ? basenameOf(sourcePath!) : (input.sessions[sessionId] ?? sessionId);
		planned.push({ sessionId, kind, title, target: "", sourcePath, members: [...nodes].sort(byCreatedThenId) });
	}
	// Clash-free names per folder: the first (by session id) keeps the plain
	// name, later ones get a short id suffix — deterministic across exports.
	const taken = new Set<string>();
	for (const note of planned) {
		const folder = `${OBSIDIAN_EXPORT_DIR}/${note.kind === "notes" ? "Notes" : "Sessions"}`;
		const base = sanitizeNoteName(note.title);
		let name = base;
		if (taken.has(`${folder}/${name}`.toLowerCase())) {
			name = `${base} (${note.sessionId.replace(/^(chat_|src_)/, "").slice(0, 8)})`;
		}
		taken.add(`${folder}/${name}`.toLowerCase());
		note.target = `${folder}/${name}`;
	}
	return planned;
}

/** Render the whole export: one file per birth session. */
export function renderObsidianExport(input: ObsidianExportInput): ObsidianExportFile[] {
	const notes = planNotes(input);
	// node id → { note, heading } — headings unique per note (" (2)" …).
	const anchor = new Map<string, { note: PlannedNote; heading: string }>();
	for (const note of notes) {
		const used = new Map<string, number>();
		for (const node of note.members) {
			const base = sanitizeHeading(node.name);
			const n = (used.get(base.toLowerCase()) ?? 0) + 1;
			used.set(base.toLowerCase(), n);
			anchor.set(node.id, { note, heading: n === 1 ? base : `${base} (${n})` });
		}
	}
	const nameOf = new Map(input.propositions.map((n) => [n.id, n.name]));
	const chainsByConclusion = new Map<string, GraphChain[]>();
	for (const chain of [...input.chains].sort(byCreatedThenId)) {
		const bucket = chainsByConclusion.get(chain.conclusion);
		if (bucket) bucket.push(chain);
		else chainsByConclusion.set(chain.conclusion, [chain]);
	}

	const linkFrom = (home: PlannedNote, nodeId: string): string => {
		const a = anchor.get(nodeId);
		if (!a) return nameOf.get(nodeId) ?? nodeId; // unanchored premise — plain text
		const display = nameOf.get(nodeId) ?? a.heading;
		return a.note === home ? `[[#${a.heading}|${display}]]` : `[[${a.note.target}#${a.heading}|${display}]]`;
	};

	return notes.map((note) => {
		const stamps = note.members.map((n) => n.createdAt);
		for (const node of note.members) for (const c of chainsByConclusion.get(node.id) ?? []) stamps.push(c.createdAt);
		const updated = stamps.sort().at(-1) ?? "";
		const lines: string[] = [
			"---",
			OBSIDIAN_EXPORT_MARKER,
			`lh_source: ${note.sessionId}`,
			`lh_kind: ${note.kind}`,
			`updated: ${updated}`,
			"---",
			`# ${note.title.replace(/\s+/g, " ").trim() || "Untitled"}`,
			"",
		];
		if (note.sourcePath !== undefined) lines.push(`Source: [[${noteLinkTarget(note.sourcePath)}]]`, "");
		for (const node of note.members) {
			lines.push(`## ${anchor.get(node.id)!.heading}`, "", node.statement.trim(), "");
			const aliases = node.aliases.map((a) => a.trim()).filter((a) => a && a !== node.name && a !== node.statement);
			if (aliases.length) lines.push(`*Also:* ${aliases.join(" · ")}`, "");
			for (const chain of chainsByConclusion.get(node.id) ?? []) {
				lines.push(`Because ${chain.premises.map((p) => linkFrom(note, p)).join(" ∧ ")} ⟹ ${node.name}`, "");
			}
		}
		return { relPath: `${note.target}.md`, content: lines.join("\n").replace(/\n+$/, "\n") };
	});
}
