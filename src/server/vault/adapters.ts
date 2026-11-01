// Vault adapters over the LearnHarness store ports (ADR 0007 "Write path", #37).
//
// Each wrapper calls the wrapped file-system store unchanged and records the outbox intent FIRST:
// `noteDocumentChangedSync` before a document write or delete, `noteLedgerAppendedSync` (with the
// byte offset where the append begins) before a ledger append. The LearnHarness ports are
// synchronous, so the synchronous note methods of the client engine are used; they fsync the
// intent before they return.
//
// Two stores cannot name the file before the write: `createChat` and `createJob` choose their id
// inside. They note after the write; a crash in between is healed by `reconcile()` at the next
// start (wire.ts), which notes every syncable file again (unchanged ones are skipped by hash).

import { statSync } from "node:fs";
import { join } from "node:path";

import type { ChatStore, GraphStore, JobStore, PromptOverrideStore, SettingsStore, SourceOrganizationStore } from "../../core/ports.ts";

/** The part of the sync engine the adapters need (`SyncEngine` satisfies it). */
export interface IntentSink {
	noteDocumentChangedSync(path: string): void;
	noteLedgerAppendedSync(file: string, offset: number): void;
}

export interface AdapterContext {
	sink: IntentSink;
	/** The synced data folder (PATHS.data). */
	dataDir: string;
	/** This device's LearnHarness id, read per write like the fork's ledger store does. */
	deviceId: () => string;
}

type Fn = (...args: never[]) => unknown;

/** `inner[key]` with `intent` called first on the same arguments. */
function intentFirst<S extends object, K extends keyof S>(inner: S, key: K, intent: (...a: any[]) => void): S[K] {
	const f = inner[key] as unknown as (...a: unknown[]) => unknown;
	return ((...a: unknown[]) => {
		intent(...a);
		return f.apply(inner, a);
	}) as unknown as S[K];
}

export const chatPath = (id: string): string => `chats/${id}.json`;
export const jobPath = (id: string): string => `jobs/${id}.json`;
export const ledgerFile = (kind: LedgerKind, deviceId: string): string => `graph/${kind}.${deviceId}.jsonl`;
export type LedgerKind = "nodes" | "chains" | "sessions" | "coverage" | "deletions";

export function wrapChatStore<S extends ChatStore>(inner: S, ctx: AdapterContext): S {
	const doc = (id: string) => ctx.sink.noteDocumentChangedSync(chatPath(id));
	return {
		...inner,
		// The id is chosen inside createChat: note after the write (see the file header).
		createChat: ((...a: never[]) => {
			const record = (inner.createChat as Fn).apply(inner, a) as { id: string };
			doc(record.id);
			return record;
		}) as S["createChat"],
		saveMessages: intentFirst(inner, "saveMessages", doc),
		saveTree: intentFirst(inner, "saveTree", doc),
		appendTurnUsage: intentFirst(inner, "appendTurnUsage", doc),
		appendExtractionUsage: intentFirst(inner, "appendExtractionUsage", doc),
		saveSettings: intentFirst(inner, "saveSettings", doc),
		setActiveTurn: intentFirst(inner, "setActiveTurn", doc),
		renameChat: intentFirst(inner, "renameChat", doc),
		deleteChat: intentFirst(inner, "deleteChat", doc),
		// Keeping a conflict copy renames it over the session file: that is a new version on the
		// current head (ADR 0008). Keeping "current" changes nothing that syncs. The conflict copies
		// themselves are device-local and are never noted.
		resolveConflict: intentFirst(inner, "resolveConflict", (id: string, keep: string) => {
			if (keep !== "current") doc(id);
		}),
	};
}

export function wrapJobStore<S extends JobStore>(inner: S, ctx: AdapterContext): S {
	const doc = (id: string) => ctx.sink.noteDocumentChangedSync(jobPath(id));
	return {
		...inner,
		createJob: ((...a: never[]) => {
			const record = (inner.createJob as Fn).apply(inner, a) as { id: string };
			doc(record.id);
			return record;
		}) as S["createJob"],
		updateJob: intentFirst(inner, "updateJob", doc),
		// One file per job of the chat: note every one before the unlinks.
		deleteJobsForChat: intentFirst(inner, "deleteJobsForChat", (chatId: string) => {
			for (const job of inner.listJobs(chatId)) doc(job.id);
		}),
	};
}

/** `ensureGraphFormat` may write graph/format.json inside any graph-family write. */
function formatNoter(ctx: AdapterContext): () => void {
	let noted = false;
	return () => {
		if (noted) return;
		ctx.sink.noteDocumentChangedSync("graph/format.json");
		noted = true;
	};
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function wrapGraphStore<S extends GraphStore>(inner: S, ctx: AdapterContext): S {
	const noteFormat = formatNoter(ctx);
	const ledger = <K extends "appendNode" | "appendChain" | "appendCheckpoint" | "appendCoverage" | "appendDeletion">(key: K, kind: LedgerKind): S[K] =>
		intentFirst(inner, key, () => {
			noteFormat();
			const file = ledgerFile(kind, ctx.deviceId());
			ctx.sink.noteLedgerAppendedSync(file, sizeOf(join(ctx.dataDir, file)));
		});
	const sources = <K extends "upsertSource" | "deleteSources" | "appendSourceUsage">(key: K): S[K] =>
		intentFirst(inner, key, () => {
			noteFormat();
			ctx.sink.noteDocumentChangedSync("graph/sources.json");
		});
	return {
		...inner,
		appendNode: ledger("appendNode", "nodes"),
		appendChain: ledger("appendChain", "chains"),
		appendCheckpoint: ledger("appendCheckpoint", "sessions"),
		appendCoverage: ledger("appendCoverage", "coverage"),
		appendDeletion: ledger("appendDeletion", "deletions"),
		upsertSource: sources("upsertSource"),
		deleteSources: sources("deleteSources"),
		appendSourceUsage: sources("appendSourceUsage"),
	};
}

export function wrapPromptOverrideStore<S extends PromptOverrideStore>(inner: S, ctx: AdapterContext): S {
	const doc = (segmentPath: string) => ctx.sink.noteDocumentChangedSync(`prompts/${segmentPath}`);
	return { ...inner, writeOverride: intentFirst(inner, "writeOverride", doc), deleteOverride: intentFirst(inner, "deleteOverride", doc) };
}

/** `writeSettings` routes agent.prompts into prompts/switches.json, which syncs; settings.json itself is device-local. */
export function wrapSettingsStore<S extends SettingsStore>(inner: S, ctx: AdapterContext): S {
	return { ...inner, writeSettings: intentFirst(inner, "writeSettings", () => ctx.sink.noteDocumentChangedSync("prompts/switches.json")) };
}

/**
 * graph/source-organization.json is NOT in ADR 0007's table (INVENTORY.md, proposed ADR change).
 * The engine ignores the note until the client mapping accepts the path, so this wrapper is
 * inert today and starts syncing the file the day the mapping and the ADR include it.
 */
export function wrapSourceOrganizationStore<S extends SourceOrganizationStore>(inner: S, ctx: AdapterContext): S {
	return {
		...inner,
		write: intentFirst(inner, "write", () => {
			ctx.sink.noteDocumentChangedSync("graph/format.json"); // the write stamps the graph format first
			ctx.sink.noteDocumentChangedSync("graph/source-organization.json");
		}),
	};
}
