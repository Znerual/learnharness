/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFLICTS_DIR, PATHS } from "../../config.ts";
import { moveFile } from "./fs-files.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ActiveTurn, ChatConflict, ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). */
function writeChat(record: ChatRecord): void {
	fs.writeFileSync(chatFile(record.id), JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"), "utf-8");
}

function getChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

/** A session file name — chat_<id>.json. Anything else in the folder (a
 *  sync tool's conflict copies and temp files) is not a session. */
const SESSION_FILE = /^([A-Za-z0-9_-]+)\.json$/;

/** The bare identity of a session saved by a NEWER app version, which
 *  getChat refuses to read (multi-device: devices update at different
 *  times) — null for anything else. */
function newerChat(id: string): Pick<ChatRecord, "id" | "title" | "createdAt" | "updatedAt"> | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8")) as Partial<ChatRecord>;
		if (typeof parsed.version !== "number" || parsed.version <= CURRENT_CHAT_VERSION) return null;
		const at = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
		return {
			id,
			title: typeof parsed.title === "string" ? parsed.title : "Untitled session",
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : at,
			updatedAt: at,
		};
	} catch {
		return null;
	}
}

/** The list entry for a session this build cannot read. */
function newerSummary(chat: Pick<ChatRecord, "id" | "title" | "createdAt" | "updatedAt">): ChatSummary {
	return { ...chat, kind: "teach", messageCount: 0, phase: "probe", pendingQuestion: false, pendingProblem: false, newer: true };
}

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		const ids = fs.readdirSync(PATHS.chats).flatMap((f) => {
			const id = SESSION_FILE.exec(f)?.[1];
			return id ? [id] : [];
		});
		const newer = ids.flatMap((id) => {
			const chat = newerChat(id);
			return chat ? [newerSummary(chat)] : [];
		});
		return ids
			.map((id) => getChat(id))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, tree, turns, extractions, ...summary }) => {
				// Per-record isolation (Wave B): a record whose messages fail the
				// projection (e.g. pre-Wave-B UIMessage-format scratch — the
				// zero-back-compat wipe makes these "corrupt") must not blank the
				// whole sidebar — same isolation getChat's per-file catch gives.
				try {
					return {
						// turns and extractions stay out of the list payload (list =
						// summaries; usage aggregates ride the full record, the picker
						// never needs them).
						...summary,
						// Normalized kind: absent record field reads as teach.
						kind: summary.kind ?? "teach",
						messageCount: messages.length,
						// Record-derived status for the session picker: phase from the
						// transcript's explicit events (probe_done concluded / verdict
						// accepted — docs/probe-teach-split.md §4), pending question
						// from the native dangling-call scan. Wave D: both folds read
						// the NATIVE record (core/phases.ts phaseAt3Lh +
						// native-messages.ts danglingQuestionOf). Liveness (busy) is
						// NOT record-derived — the API route merges it (ChatListItem).
						phase: phaseAt3Lh(messages),
						pendingQuestion: danglingQuestionOf(messages) !== null,
					};
				} catch (err) {
					console.error(`[chat ${summary.id}] summary projection failed:`, err);
					return null;
				}
			})
			.filter((s): s is ChatSummary => s !== null)
			.concat(newer)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		fs.unlinkSync(chatFile(id));
		// Its conflict copies go with it — set aside, never deleted (owner, 2026-10-30).
		try {
			for (const copy of listConflicts(id)) setAside(path.join(PATHS.chats, copy.file), copy.file);
		} catch (err) {
			console.error(`[chat ${id}] could not set its conflict copies aside:`, err);
		}
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Set or clear the turn's owning device (multi-device). Not conversation
 *  activity: updatedAt stays put, like saveSettings. */
function setActiveTurn(id: string, activeTurn: ActiveTurn | null): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	if (activeTurn) record.activeTurn = activeTurn;
	else delete record.activeTurn;
	writeChat(record);
}

// ─── conflict copies (multi-device, GLOSSARY "Conflict copy") ──────────────────

/** Syncthing's name for the version it kept beside a file two devices
 *  changed: <name>.sync-conflict-<date>-<time>-<device>.<ext>. */
function conflictPattern(id: string): RegExp {
	return new RegExp(`^${id}\\.sync-conflict-[A-Za-z0-9-]+\\.json$`);
}

/** The conflict copies of one session, oldest file name first. */
function listConflicts(id: string): ChatConflict[] {
	chatFile(id); // id guard
	const pattern = conflictPattern(id);
	let names: string[];
	try {
		names = fs.readdirSync(PATHS.chats).filter((f) => pattern.test(f)).sort();
	} catch {
		return [];
	}
	return names.flatMap((file) => {
		try {
			const record = JSON.parse(fs.readFileSync(path.join(PATHS.chats, file), "utf-8")) as Partial<ChatRecord>;
			return [{ file, updatedAt: String(record.updatedAt ?? ""), messageCount: Array.isArray(record.messages) ? record.messages.length : 0 }];
		} catch {
			return []; // unreadable copy: nothing the learner can pick
		}
	});
}

/** Move a file into the device-local conflicts folder (never deleted). */
function setAside(from: string, name: string): void {
	moveFile(from, path.join(CONFLICTS_DIR, name));
}

/**
 * Keep one version of a conflicted session: "current" (the session file)
 * or the file name of one of its conflict copies. Every other version moves
 * to the conflicts folder. False when `keep` names no copy of this session.
 */
function resolveConflict(id: string, keep: string): boolean {
	const copies = listConflicts(id).map((c) => c.file);
	if (keep !== "current" && !copies.includes(keep)) return false;
	if (keep !== "current") {
		setAside(chatFile(id), `${id}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
		fs.renameSync(path.join(PATHS.chats, keep), chatFile(id));
	}
	for (const copy of copies) if (copy !== keep) setAside(path.join(PATHS.chats, copy), copy);
	emit("chats-changed", {});
	return true;
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	setActiveTurn,
	listConflicts,
	resolveConflict,
	newerChat,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
