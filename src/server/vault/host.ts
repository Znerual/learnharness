// The LearnHarness SyncHost (#37, #40): writes pulled changes in remote mode (no outbox entry) and
// tells open views about them through the fork's existing app-scoped events.

import { mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { FsHost, type AppliedChange, isDocumentPath, parseLedgerFile } from "@znerual/learnharness-vault-client";

import type { ServerEventType } from "../../core/events.ts";

/** `emit` from src/core/events.ts, loosened: the payload of each event is built from the changed paths. */
export type EmitFn = (type: ServerEventType, payload: Record<string, unknown>) => void;

export interface HostEvent {
	type: ServerEventType;
	payload: Record<string, unknown>;
}

/**
 * Which existing events a pulled change needs (ADR 0007 read path). The events carry the fact,
 * never the data (src/core/events.ts), so views refetch:
 *
 * - chats/<id>.json: `chats-changed` (list shape: create, delete, title) and `record-changed`
 *   {chatId} (an open session adopts the durable record). A conflict version created during a
 *   push also reports the session path, so the picker's badge refreshes the same way.
 * - jobs/<id>.json: `jobs-changed` {chatId} (chat view and activity dock refetch).
 * - graph ledger segments: `activity-changed` (graph view refetches).
 * - graph/sources.json, graph/format.json: `sources-changed` and `activity-changed`, like the
 *   sources routes emit.
 * - prompts/*: none; prompts are read fresh on every turn.
 *
 * `jobChatId` resolves a job's chat id from its file (a tombstone has none: the event then goes
 * out without a chat id, which consumers treat as "any chat").
 */
export function eventsFor(changes: AppliedChange[], jobChatId: (path: string) => string | undefined = () => undefined): HostEvent[] {
	const out: HostEvent[] = [];
	const seen = new Set<string>();
	const push = (type: ServerEventType, payload: Record<string, unknown> = {}) => {
		const key = `${type}:${JSON.stringify(payload)}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ type, payload });
	};
	for (const c of changes) {
		const chat = /^chats\/([A-Za-z0-9_-]+)\.json$/.exec(c.path);
		const job = /^jobs\/([A-Za-z0-9_-]+)\.json$/.exec(c.path);
		if (chat) {
			push("chats-changed");
			push("record-changed", { chatId: chat[1] });
		} else if (job) {
			const chatId = jobChatId(c.path);
			push("jobs-changed", chatId ? { chatId } : {});
		} else if (c.kind === "seg" || parseLedgerFile(c.path)) {
			push("activity-changed");
		} else if (c.path === "graph/sources.json" || c.path === "graph/format.json" || c.path === "graph/source-organization.json") {
			push("sources-changed");
			push("activity-changed");
		}
	}
	return out;
}

export interface LearnHarnessHostOptions {
	/** The synced data folder (PATHS.data). */
	dataDir: string;
	/**
	 * The device-local folder (PATHS.local). In the fork it sits OUTSIDE the data folder
	 * (LH_LOCAL_DIR; config.ts), so the engine's `local/...` paths map here, not to <data>/local.
	 */
	localDir: string;
	/** `emit` from src/core/events.ts. */
	emit: EmitFn;
}

/**
 * A SyncHost over the data folder. Reads and writes go straight to the files LearnHarness's own
 * file-system stores use (same JSON bytes), not through the wrapped stores: remote mode must not
 * add outbox entries. Device-local engine paths (`local/conflicts/...`) map to `localDir`.
 */
export class LearnHarnessHost extends FsHost {
	readonly localDir: string;
	private readonly local: FsHost;
	private readonly emit: EmitFn;

	constructor(o: LearnHarnessHostOptions) {
		super(o.dataDir);
		this.localDir = o.localDir;
		this.local = new FsHost(o.localDir);
		this.emit = o.emit;
	}

	private static inLocal(path: string): string | null {
		return path.startsWith("local/") ? path.slice("local/".length) : null;
	}

	override async readDocument(path: string): Promise<Uint8Array | null> {
		const l = LearnHarnessHost.inLocal(path);
		return l !== null ? this.local.readDocument(l) : super.readDocument(path);
	}

	override async writeConflict(path: string, data: Uint8Array): Promise<void> {
		const l = LearnHarnessHost.inLocal(path);
		if (l !== null) await this.local.writeConflict(l, data);
		else await super.writeConflict(path, data);
	}

	/** A deleted session takes its conflict copies to the device-local conflicts folder, as `chatStore.deleteChat` does. */
	override async deleteDocument(path: string): Promise<void> {
		await super.deleteDocument(path);
		const chat = /^chats\/([A-Za-z0-9_-]+)\.json$/.exec(path);
		if (!chat) return;
		const dir = join(this.root, "chats");
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((f) => f.startsWith(`${chat[1]}.sync-conflict-`) && f.endsWith(".json"));
		} catch {
			return;
		}
		for (const name of names) {
			mkdirSync(join(this.localDir, "conflicts"), { recursive: true });
			renameSync(join(dir, name), join(this.localDir, "conflicts", name));
		}
	}

	/** Syncable files only (documents and ledgers), POSIX-relative. */
	override async listFiles(): Promise<string[]> {
		return (await super.listFiles()).filter((f) => isDocumentPath(f) || parseLedgerFile(f));
	}

	/** Every regular file under the data folder (joining moves them all aside). */
	async listAllFiles(): Promise<string[]> {
		return super.listFiles();
	}

	override applied(changes: AppliedChange[]): void {
		super.applied(changes);
		const jobChatId = (path: string): string | undefined => {
			try {
				const chatId = (JSON.parse(readFileSync(join(this.root, path), "utf8")) as { chatId?: unknown }).chatId;
				return typeof chatId === "string" ? chatId : undefined;
			} catch {
				return undefined;
			}
		};
		for (const e of eventsFor(changes, jobChatId)) {
			try {
				this.emit(e.type, e.payload);
			} catch {
				// a failing listener never breaks sync
			}
		}
	}
}
