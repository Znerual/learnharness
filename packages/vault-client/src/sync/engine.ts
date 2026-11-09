// The sync engine (ADR 0007, ADR 0008, #31): outbox, push, pull, conflicts, segments,
// rotation handling and background re-encryption. It knows nothing about LearnHarness beyond
// the host interface and the record mapping.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import WebSocket from "ws";

import { ApiError, NetworkError } from "../api/client.ts";
import type { ChangeRow, ChangesResponse, WriteMeta, WriteResult } from "../api/types.ts";
import { bytesEqual, decryptRecord, encryptRecord, type RecordHeader, toHex, vaultKeyFor, ProtocolError } from "../crypto/index.ts";
import type { Vault } from "../vault.ts";
import { appendFsyncSync, appendSync, writeFileAtomic, writeFileAtomicSync } from "./fsutil.ts";
import type { AppliedChange, SyncHost } from "./host.ts";
import { conflictPath, isDocumentPath, parseLedgerFile, parseSegmentPath, segmentPath } from "./mapping.ts";

export const MAX_SEGMENT_BYTES = 1 << 20;
const MAX_BATCH_WRITES = 100;
const MAX_BATCH_BYTES = 48 << 20; // below the 64 MiB server limit, leaving room for overhead
const POLL_MS = 60_000;

type OutboxEntry = { t: "doc"; p: string } | { t: "led"; f: string; o: number };

interface HeadState {
	seq: number;
	/** SHA-256 of the plaintext body, to skip pushing unchanged documents. */
	sha: string;
	deleted: boolean;
}

interface PendingSegment {
	file: string;
	offset: number;
	recordId: string;
	sha256: string;
}

interface EngineState {
	v: 1;
	lastSeq: number;
	heads: Record<string, HeadState>;
	ledgerPushed: Record<string, number>;
	pendingSegments: PendingSegment[];
	/** Segment boundaries planned before a push, reused after a crash so a re-push matches. */
	ledgerInflight?: Record<string, [number, number][]>;
	lastSuccess: string | null;
}

export type SyncState = "idle" | "syncing" | "offline" | "error" | "over_quota" | "read_only" | "rotation_rejected" | "revoked" | "needs_unlock";

export interface SyncStatus {
	state: SyncState;
	pendingChanges: number;
	lastSuccess: string | null;
	error?: string;
	conflicts: number;
	rollbacks: number;
	/** Changes the server offered that were refused (bad path, not a synced document). */
	rejected: number;
}

export interface SyncEngineOptions {
	vault: Vault;
	host: SyncHost;
	/** Directory for outbox.jsonl and state.json, normally <data>/local/vault. */
	stateDir: string;
	/** This installation's LearnHarness device id (owner of its ledger files). */
	deviceId: string;
	now?: () => Date;
	onStatus?: (s: SyncStatus) => void;
	/** Test hook: called before each crash-relevant step; throwing simulates a crash. */
	faultPoint?: (name: string) => void;
}

export interface SyncReport {
	pulled: number;
	pushed: number;
	conflicts: string[];
}

function sha256Hex(b: Uint8Array): string {
	return createHash("sha256").update(b).digest("hex");
}

function jitter(ms: number): number {
	return Math.round(ms * (0.5 + Math.random()));
}

export class SyncEngine {
	private readonly o: SyncEngineOptions;
	private state: EngineState = { v: 1, lastSeq: 0, heads: {}, ledgerPushed: {}, pendingSegments: [], lastSuccess: null };
	private outbox: OutboxEntry[] = [];
	private statusValue: SyncStatus = { state: "idle", pendingChanges: 0, lastSuccess: null, conflicts: 0, rollbacks: 0, rejected: 0 };
	private running: Promise<SyncReport> | null = null;
	private again = false;
	private timer: NodeJS.Timeout | null = null;
	private ws: WebSocket | null = null;
	private stopped = true;
	private backoffMs = 0;
	private lock: Promise<void> = Promise.resolve();

	constructor(o: SyncEngineOptions) {
		this.o = o;
	}

	private get outboxPath(): string {
		return join(this.o.stateDir, "outbox.jsonl");
	}
	private get statePath(): string {
		return join(this.o.stateDir, "state.json");
	}
	private fault(name: string): void {
		this.o.faultPoint?.(name);
	}
	private now(): Date {
		return this.o.now?.() ?? new Date();
	}

	/** Loads the outbox and state from disk. Call once before anything else. */
	async init(): Promise<void> {
		try {
			const s = JSON.parse(await readFile(this.statePath, "utf8")) as EngineState;
			if (s.v === 1) this.state = s;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		this.outbox = await this.readOutbox();
		this.statusValue = { ...this.statusValue, pendingChanges: this.outbox.length, lastSuccess: this.state.lastSuccess };
	}

	private async readOutbox(): Promise<OutboxEntry[]> {
		let text: string;
		try {
			text = await readFile(this.outboxPath, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		const out: OutboxEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as OutboxEntry);
			} catch {
				// a torn last line after a crash: the write it described was not yet made (intent first)
			}
		}
		return out;
	}

	private serialize<T>(f: () => Promise<T>): Promise<T> {
		const p = this.lock.then(f, f);
		this.lock = p.then(() => undefined, () => undefined);
		return p;
	}

	/**
	 * Records that a document changed. The host must call this BEFORE it writes the file
	 * (intent first): a crash between the two then pushes the old content, never loses the new.
	 */
	async noteDocumentChanged(path: string): Promise<void> {
		if (!isDocumentPath(path)) return;
		await this.serialize(async () => {
			const e: OutboxEntry = { t: "doc", p: path };
			await appendSync(this.outboxPath, `${JSON.stringify(e)}\n`);
			this.outbox.push(e);
		});
		this.setStatus({});
	}

	/**
	 * Synchronous `noteDocumentChanged`, for hosts whose store ports are synchronous (the LearnHarness
	 * stores are). It fsyncs the intent before it returns, so the caller can write the file right after.
	 */
	noteDocumentChangedSync(path: string): void {
		if (!isDocumentPath(path)) return;
		const e: OutboxEntry = { t: "doc", p: path };
		appendFsyncSync(this.outboxPath, `${JSON.stringify(e)}\n`);
		this.outbox.push(e);
		this.setStatus({});
	}

	/** Synchronous `noteLedgerAppended`; see `noteDocumentChangedSync`. */
	noteLedgerAppendedSync(file: string, offset: number): void {
		if (!parseLedgerFile(file)) return;
		const e: OutboxEntry = { t: "led", f: file, o: offset };
		appendFsyncSync(this.outboxPath, `${JSON.stringify(e)}\n`);
		this.outbox.push(e);
		this.setStatus({});
	}

	/**
	 * Declares that the first `length` bytes of a ledger file are already in the vault, so a push
	 * starts after them. Used when joining with an own ledger file that matches the vault's segments
	 * (ADR 0007 "Joining"): the vault's segment boundaries need not match a fresh plan.
	 */
	async adoptLedgerPushed(file: string, length: number): Promise<void> {
		if (!parseLedgerFile(file)) throw new Error(`not a ledger file: ${file}`);
		this.state.ledgerPushed[file] = Math.max(this.state.ledgerPushed[file] ?? 0, length);
		await this.saveState();
	}

	/** Records that bytes were appended to a ledger file starting at offset. */
	async noteLedgerAppended(file: string, offset: number): Promise<void> {
		if (!parseLedgerFile(file)) return;
		await this.serialize(async () => {
			const e: OutboxEntry = { t: "led", f: file, o: offset };
			await appendSync(this.outboxPath, `${JSON.stringify(e)}\n`);
			this.outbox.push(e);
		});
		this.setStatus({});
	}

	/** Seeds the vault from an existing data folder (first device, ADR 0007 "Joining"). */
	async seedAll(): Promise<number> {
		if (!this.o.host.listFiles) throw new Error("the host cannot list files");
		let n = 0;
		for (const f of await this.o.host.listFiles()) {
			if (isDocumentPath(f)) {
				const head = this.state.heads[f];
				const local = await this.o.host.readDocument(f);
				if (local !== null && head && !head.deleted && head.sha === sha256Hex(local)) continue; // already in the vault
				await this.noteDocumentChanged(f);
				n++;
			} else if (parseLedgerFile(f)) {
				const pushed = this.state.ledgerPushed[f] ?? 0;
				if (pushed > 0 && pushed >= (await this.o.host.ledgerSize(f))) continue; // fully pushed
				await this.noteLedgerAppended(f, 0);
				n++;
			}
		}
		return n;
	}

	/**
	 * What this device knows about a document in the vault, as of its last sync: "live", "deleted"
	 * (the head version is a deletion) or "unknown" (no version seen). Taken from the authenticated
	 * record header, never from the server's tombstone flag. A merge of old local data uses it to
	 * skip documents deleted in the vault instead of bringing them back.
	 */
	documentState(path: string): "live" | "deleted" | "unknown" {
		const head = this.state.heads[path];
		return !head ? "unknown" : head.deleted ? "deleted" : "live";
	}

	status(): SyncStatus {
		return { ...this.statusValue };
	}

	private setStatus(s: Partial<SyncStatus>): void {
		this.statusValue = { ...this.statusValue, ...s, pendingChanges: this.outbox.length, lastSuccess: this.state.lastSuccess };
		this.o.onStatus?.(this.status());
	}

	private async saveState(): Promise<void> {
		this.fault("save-state");
		await writeFileAtomic(this.statePath, JSON.stringify(this.state));
	}

	/** Rewrites the outbox without the entries in `done` (entries appended meanwhile stay). */
	private async compactOutbox(done: Set<OutboxEntry>): Promise<void> {
		await this.serialize(async () => {
			this.fault("compact-outbox");
			// Synchronous from the filter to the rename, so a synchronous note cannot slip in between
			// (its line would be lost with the replaced file).
			this.outbox = this.outbox.filter((e) => !done.has(e));
			writeFileAtomicSync(this.outboxPath, this.outbox.map((e) => `${JSON.stringify(e)}\n`).join(""));
		});
	}

	// ---------------------------------------------------------------- one sync cycle

	/** Runs one cycle: keys, pull, push, pull. Concurrent calls coalesce into one extra cycle. */
	sync(): Promise<SyncReport> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			let report: SyncReport = { pulled: 0, pushed: 0, conflicts: [] };
			try {
				do {
					this.again = false;
					const r = await this.cycle();
					report = { pulled: report.pulled + r.pulled, pushed: report.pushed + r.pushed, conflicts: [...report.conflicts, ...r.conflicts] };
				} while (this.again);
				return report;
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	private async cycle(): Promise<SyncReport> {
		const vault = this.o.vault;
		if (vault.mustSetPassword) {
			this.setStatus({ state: "needs_unlock", error: "set a new password before sync starts" });
			return { pulled: 0, pushed: 0, conflicts: [] };
		}
		this.setStatus({ state: "syncing", error: undefined as unknown as string });
		const report: SyncReport = { pulled: 0, pushed: 0, conflicts: [] };
		try {
			report.pulled += await this.pull();
			const pushed = await this.push(report);
			report.pushed += pushed;
			if (pushed > 0) report.pulled += await this.pull();
			this.state.lastSuccess = this.now().toISOString();
			await this.saveState();
			if (this.statusValue.state === "syncing") this.setStatus({ state: "idle" });
			this.backoffMs = 0;
		} catch (e) {
			this.classify(e);
			throw e;
		}
		return report;
	}

	private classify(e: unknown): void {
		if (e instanceof NetworkError) return this.setStatus({ state: "offline", error: e.message });
		if (e instanceof ProtocolError && (e.code === "rotation_rejected" || e.code === "rollback")) return this.setStatus({ state: "rotation_rejected", error: e.message });
		if (e instanceof ApiError && e.status === 401) return this.setStatus({ state: "revoked", error: "this device is signed out or revoked" });
		const code = (e as { code?: string }).code;
		if (code === "revoked") return this.setStatus({ state: "revoked", error: (e as Error).message });
		if (code === "needs_unlock") return this.setStatus({ state: "needs_unlock", error: (e as Error).message });
		this.setStatus({ state: "error", error: (e as Error).message });
	}

	// ---------------------------------------------------------------- pull

	private async fetchChanges(since: number): Promise<ChangesResponse> {
		return this.o.vault.api.get<ChangesResponse>(`/v1/changes?since=${since}&limit=500`, this.o.vault.auth());
	}

	private async pull(): Promise<number> {
		const vault = this.o.vault;
		let applied = 0;
		const appliedChanges: AppliedChange[] = [];
		const pendingDocs = new Set(this.outbox.filter((e) => e.t === "doc").map((e) => (e as { p: string }).p));
		for (;;) {
			const ch = await this.fetchChanges(this.state.lastSeq);
			if (ch.generation !== vault.keys.generation) await vault.refreshKeys();
			for (const c of ch.changes) {
				const a = await this.applyChange(c, pendingDocs);
				if (a) {
					appliedChanges.push(a);
					applied++;
				}
			}
			this.state.lastSeq = ch.cursor;
			await this.retryPendingSegments(appliedChanges);
			await this.saveState();
			if (!ch.more) break;
		}
		if (appliedChanges.length > 0) this.o.host.applied?.(appliedChanges);
		return applied;
	}

	private async openRecord(c: { recordId: string; kind: "doc" | "seg"; sha256: string }): Promise<{ header: RecordHeader; body: Uint8Array }> {
		const vault = this.o.vault;
		const env = await vault.api.blob(c.sha256, vault.auth());
		if (sha256Hex(env) !== c.sha256) throw new Error(`blob ${c.sha256} does not match its hash`);
		const keys = vault.keys;
		return decryptRecord(keys.accountId, keys.ik, c.recordId, c.kind, env, (e) => vaultKeyFor(keys, e));
	}

	private async applyChange(c: ChangeRow, pendingDocs: Set<string>): Promise<AppliedChange | null> {
		const { header, body } = await this.openRecord(c);
		if (header.kind === "doc") {
			if (!isDocumentPath(header.path)) return this.reject(`the server offered a record at ${JSON.stringify(header.path)}, which is not a synced document`);
			const known = this.state.heads[header.path];
			if (known && c.seq < known.seq) {
				// Rollback (ADR 0002 consequences): refuse and report.
				this.statusValue.rollbacks++;
				this.setStatus({ error: `the server returned an older version of ${header.path}` });
				return null;
			}
			if (known && c.seq === known.seq) return null;
			// A local change waits: it blocks the remote one only if the local content really differs from the
			// known head. Otherwise the remote version applies and the push drops the entry (nothing is lost).
			if ((pendingDocs.has(header.path) || this.hasPendingDoc(header.path)) && !(await this.localEqualsHead(header.path))) return null;
			// Only the authenticated header says whether a version deletes the document; ChangeRow.tombstone is server-supplied.
			const deleted = header.deleted;
			this.fault("apply-doc");
			// Re-check right before writing: a local change that arrived during the pull is never overwritten.
			if (this.hasPendingDoc(header.path) && !(await this.localEqualsHead(header.path))) return null;
			if (deleted) await this.o.host.deleteDocument(header.path);
			else await this.o.host.writeDocument(header.path, body);
			this.state.heads[header.path] = { seq: c.seq, sha: sha256Hex(body), deleted };
			return { path: header.path, kind: "doc", deleted };
		}
		const seg = parseSegmentPath(header.path);
		if (!seg || seg.offset !== header.offset || seg.ledger !== header.ledger) return this.reject(`segment ${c.recordId} has a malformed path`);
		if (seg.owner === this.o.deviceId) return null; // own ledger: the local file is the source
		return this.applySegment(seg.file, seg.offset, body, c);
	}

	private hasPendingDoc(path: string): boolean {
		return this.outbox.some((e) => e.t === "doc" && e.p === path);
	}

	/** True when the local file matches the version this device knows as head (absent equals absent or deleted). */
	private async localEqualsHead(path: string): Promise<boolean> {
		const local = await this.o.host.readDocument(path);
		const head = this.state.heads[path];
		if (local === null) return !head || head.deleted;
		return !!head && !head.deleted && head.sha === sha256Hex(local);
	}

	private reject(message: string): null {
		this.statusValue.rejected++;
		this.setStatus({ error: message });
		return null;
	}

	private async applySegment(file: string, offset: number, body: Uint8Array, c: { recordId: string; sha256: string }): Promise<AppliedChange | null> {
		const size = await this.o.host.ledgerSize(file);
		if (offset > size) {
			if (!this.state.pendingSegments.some((p) => p.file === file && p.offset === offset)) {
				this.state.pendingSegments.push({ file, offset, recordId: c.recordId, sha256: c.sha256 });
			}
			return null;
		}
		if (offset + body.length <= size) return null; // already present
		this.fault("apply-seg");
		await this.o.host.writeLedger(file, offset, body);
		return { path: file, kind: "seg", deleted: false };
	}

	private async retryPendingSegments(applied: AppliedChange[]): Promise<void> {
		let progress = true;
		while (progress && this.state.pendingSegments.length > 0) {
			progress = false;
			const list = [...this.state.pendingSegments].sort((a, b) => a.offset - b.offset);
			for (const p of list) {
				const size = await this.o.host.ledgerSize(p.file);
				if (p.offset > size) continue;
				const { body } = await this.openRecord({ recordId: p.recordId, kind: "seg", sha256: p.sha256 });
				if (p.offset + body.length > size) {
					await this.o.host.writeLedger(p.file, p.offset, body);
					applied.push({ path: p.file, kind: "seg", deleted: false });
				}
				this.state.pendingSegments = this.state.pendingSegments.filter((x) => x !== p);
				progress = true;
			}
		}
	}

	// ---------------------------------------------------------------- push

	private async push(report: SyncReport): Promise<number> {
		const snapshot = [...this.outbox];
		if (snapshot.length === 0) return 0;
		const vault = this.o.vault;
		const done = new Set<OutboxEntry>();
		const docPaths = new Map<string, OutboxEntry[]>();
		const ledgerFiles = new Map<string, OutboxEntry[]>();
		for (const e of snapshot) {
			const m = e.t === "doc" ? docPaths : ledgerFiles;
			const k = e.t === "doc" ? e.p : e.f;
			m.set(k, [...(m.get(k) ?? []), e]);
		}

		interface Item {
			meta: WriteMeta;
			envelope: Uint8Array;
			body: Uint8Array;
			path: string;
			file?: string;
			offset?: number;
			entries: OutboxEntry[];
			deleted: boolean;
		}
		const items: Item[] = [];
		const keys = vault.keys;
		const epoch = vault.epoch;
		const vk = vaultKeyFor(keys, epoch) as Uint8Array;
		const writtenAt = this.now().toISOString();

		for (const [path, entries] of docPaths) {
			const content = await this.o.host.readDocument(path);
			const head = this.state.heads[path];
			if (content === null && (!head || head.deleted)) {
				entries.forEach((e) => done.add(e));
				continue;
			}
			if (content !== null && head && !head.deleted && head.sha === sha256Hex(content)) {
				entries.forEach((e) => done.add(e));
				continue;
			}
			const deleted = content === null;
			const body = content ?? new Uint8Array(0);
			const header: RecordHeader = { kind: "doc", path, baseSeq: head?.seq ?? 0, deleted, deviceId: this.o.deviceId, writtenAt };
			const sealed = encryptRecord(keys.accountId, keys.ik, epoch, vk, { header, body });
			items.push({
				meta: { recordId: sealed.recordId, kind: "doc", baseSeq: head?.seq ?? 0, epoch, tombstone: deleted, sha256: sha256Hex(sealed.envelope), size: sealed.envelope.length },
				envelope: sealed.envelope, body, path, entries, deleted,
			});
		}

		for (const [file, entries] of ledgerFiles) {
			const info = parseLedgerFile(file);
			if (!info) {
				entries.forEach((e) => done.add(e));
				continue;
			}
			const from = this.state.ledgerPushed[file] ?? 0;
			const bytes = await this.o.host.readLedger(file, from);
			const end = bytes.lastIndexOf(0x0a) + 1; // only complete lines
			const planned = (this.state.ledgerInflight?.[file] ?? []).filter(([o]) => o >= from).sort((x, y) => x[0] - y[0]);
			const plan: [number, number][] = [];
			let off = 0;
			while (off < end) {
				let cut = Math.min(end, off + MAX_SEGMENT_BYTES);
				if (cut < end) {
					const nl = bytes.lastIndexOf(0x0a, cut - 1);
					cut = nl >= off ? nl + 1 : bytes.indexOf(0x0a, cut) + 1; // a single line over 1 MiB stays whole
				}
				const p = planned.find(([o]) => o === from + off);
				if (p && from + off + p[1] <= from + end) cut = off + p[1]; // same boundary as before a crash
				plan.push([from + off, cut - off]);
				const body = bytes.slice(off, cut);
				const offset = from + off;
				const path = segmentPath(file, offset);
				const header: RecordHeader = { kind: "seg", path, ledger: info.ledger, deviceId: this.o.deviceId, offset, writtenAt };
				const sealed = encryptRecord(keys.accountId, keys.ik, epoch, vk, { header, body });
				items.push({
					meta: { recordId: sealed.recordId, kind: "seg", epoch, tombstone: false, sha256: sha256Hex(sealed.envelope), size: sealed.envelope.length },
					envelope: sealed.envelope, body, path, file, offset, entries: [], deleted: false,
				});
				off = cut;
			}
			// The ledger's entries finish only with its last segment: a failed earlier segment skips it (ledgerFailed).
			if (plan.length > 0) (items[items.length - 1] as Item).entries = entries;
			if (end === 0) entries.forEach((e) => done.add(e));
			if (plan.length > 0) (this.state.ledgerInflight ??= {})[file] = plan;
		}
		if (items.some((i) => i.file)) await this.saveState(); // the plan is durable before anything is sent

		let pushed = 0;
		let staleEpoch = false;
		const ledgerFailed = new Set<string>();
		for (let i = 0; i < items.length; ) {
			const batch: Item[] = [];
			let bytes = 0;
			while (i < items.length && batch.length < MAX_BATCH_WRITES && (batch.length === 0 || bytes + (items[i] as Item).envelope.length <= MAX_BATCH_BYTES)) {
				bytes += (items[i] as Item).envelope.length;
				batch.push(items[i] as Item);
				i++;
			}
			const form = new FormData();
			form.append("writes", JSON.stringify({ writes: batch.map((b) => b.meta) }));
			for (const b of batch) form.append("blob", new Blob([b.envelope as Uint8Array<ArrayBuffer>]), b.meta.sha256);
			this.fault("before-push");
			const res = await vault.api.multipart<{ results: WriteResult[] }>("/v1/records", form, vault.auth());
			this.fault("after-push");
			for (let j = 0; j < batch.length; j++) {
				const it = batch[j] as Item;
				const r = res.results[j] as WriteResult;
				if (it.file && ledgerFailed.has(it.file)) continue;
				switch (r.status) {
					case "accepted":
						pushed++;
						if (it.meta.kind === "doc") this.state.heads[it.path] = { seq: r.seq, sha: sha256Hex(it.body), deleted: it.deleted };
						else this.state.ledgerPushed[it.file as string] = (it.offset as number) + it.body.length;
						it.entries.forEach((e) => done.add(e));
						break;
					case "conflict":
						if (await this.resolveConflict(it.path, it.meta.recordId, r.headSeq, report)) it.entries.forEach((e) => done.add(e));
						else this.again = true; // our own accepted write was lost by a crash: push the current content on top
						break;
					case "exists": {
						const same = r.sha256 === it.meta.sha256 || (await this.sameSegment(it.meta.recordId, r.sha256, it.body));
						if (!same) {
							ledgerFailed.add(it.file as string);
							this.setStatus({ state: "error", error: `ledger ${it.file} differs from the vault at offset ${it.offset}` });
							break;
						}
						this.state.ledgerPushed[it.file as string] = (it.offset as number) + it.body.length;
						it.entries.forEach((e) => done.add(e));
						break;
					}
					case "stale_epoch":
						staleEpoch = true;
						if (it.file) ledgerFailed.add(it.file);
						break;
					case "payment_required":
						if (it.file) ledgerFailed.add(it.file);
						this.setStatus({ state: r.error === "quota_exceeded" ? "over_quota" : "read_only", error: r.message });
						break;
					default:
						if (it.file) ledgerFailed.add(it.file);
						this.setStatus({ state: "error", error: `${r.recordId}: ${r.error}: ${r.message}` });
				}
			}
			await this.saveState();
		}
		for (const [f, plan] of Object.entries(this.state.ledgerInflight ?? {})) {
			const kept = plan.filter(([o]) => o >= (this.state.ledgerPushed[f] ?? 0));
			if (kept.length > 0) (this.state.ledgerInflight as Record<string, [number, number][]>)[f] = kept;
			else delete (this.state.ledgerInflight as Record<string, [number, number][]>)[f];
		}
		await this.compactOutbox(done);
		if (staleEpoch) {
			// A rotation happened (ADR 0006 step 6): accept the new generation and push again.
			await vault.refreshKeys();
			this.again = true;
		}
		return pushed;
	}

	private async sameSegment(recordId: string, sha: string, body: Uint8Array): Promise<boolean> {
		try {
			const r = await this.openRecord({ recordId, kind: "seg", sha256: sha });
			return bytesEqual(r.body, body);
		} catch {
			return false;
		}
	}

	/**
	 * ADR 0008: on 409, pull the head, store it as the local file and keep the local version as a
	 * conflict version. When the head already equals the local content (a crash after the server
	 * accepted it), there is no conflict.
	 */
	private async resolveConflict(path: string, recordId: string, headSeq: number, report: SyncReport): Promise<boolean> {
		const vault = this.o.vault;
		const hist = await vault.api.get<{ versions: ChangeRow[] }>(`/v1/history/${recordId}`, vault.auth());
		const head = hist.versions.find((v) => v.seq === headSeq) ?? hist.versions[0];
		if (!head) throw new Error(`no head for ${path}`);
		const { header, body } = await this.openRecord(head);
		if (header.kind !== "doc" || !isDocumentPath(header.path)) throw new ProtocolError("wrong_record", `the head of ${path} is not a document record`);
		const headDeleted = header.deleted;
		const local = await this.o.host.readDocument(path);
		if ((local === null && headDeleted) || (local !== null && !headDeleted && bytesEqual(local, body))) {
			this.state.heads[path] = { seq: head.seq, sha: sha256Hex(body), deleted: headDeleted };
			return true;
		}
		// The head is this device's own write on top of the version we knew: the server accepted it,
		// then a crash lost the answer. Not a conflict; adopt it as the base and push again.
		const known = this.state.heads[path]?.seq ?? 0;
		if (header.kind === "doc" && header.deviceId === this.o.deviceId && header.baseSeq === known) {
			this.state.heads[path] = { seq: head.seq, sha: sha256Hex(body), deleted: headDeleted };
			return false;
		}
		if (local !== null) {
			// Never overwrite an earlier conflict version (two conflicts in the same second).
			let cp = conflictPath(path, this.o.deviceId, this.now());
			for (let i = 1; (await this.o.host.readDocument(cp)) !== null; i++) cp = conflictPath(path, this.o.deviceId, new Date(this.now().getTime() + i * 1000));
			this.fault("write-conflict");
			await this.o.host.writeConflict(cp, local);
			report.conflicts.push(cp);
			this.statusValue.conflicts++;
		}
		if (headDeleted) await this.o.host.deleteDocument(path);
		else await this.o.host.writeDocument(path, body);
		this.state.heads[path] = { seq: head.seq, sha: sha256Hex(body), deleted: headDeleted };
		this.o.host.applied?.([{ path, kind: "doc", deleted: headDeleted }]);
		return true;
	}

	// ---------------------------------------------------------------- re-encryption (ADR 0006 step 7)

	/** Re-encrypts up to 100 heads from older epochs under the current vault key. */
	async reencryptBatch(): Promise<number> {
		const vault = this.o.vault;
		const r = await vault.api.post<{ heads: ChangeRow[] }>("/v1/reencrypt/claim", {}, vault.auth());
		let n = 0;
		for (const h of r.heads) {
			const keys = vault.keys;
			const epoch = vault.epoch;
			const { header, body } = await this.openRecord(h);
			const sealed = encryptRecord(keys.accountId, keys.ik, epoch, vaultKeyFor(keys, epoch) as Uint8Array, { header, body });
			const form = new FormData();
			form.append("meta", JSON.stringify({ recordId: h.recordId, seq: h.seq, oldSha256: h.sha256, epoch, sha256: sha256Hex(sealed.envelope), size: sealed.envelope.length }));
			form.append("blob", new Blob([sealed.envelope as Uint8Array<ArrayBuffer>]), "blob");
			try {
				await vault.api.multipart("/v1/reencrypt", form, vault.auth());
				n++;
			} catch (e) {
				if (e instanceof ApiError && e.status === 409) continue; // the head changed; nothing to do
				throw e;
			}
		}
		return n;
	}

	// ---------------------------------------------------------------- triggers

	/** Starts background sync: now, on WebSocket notices, every 60 s, with backoff on errors. */
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
		this.schedule(0);
	}

	/** Call when the app comes to the foreground. */
	foreground(): void {
		this.schedule(0);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.ws?.close();
		this.ws = null;
	}

	private schedule(ms: number): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.sync()
				.then(async () => {
					await this.reencryptBatch().catch(() => 0);
					this.schedule(POLL_MS);
				})
				.catch(() => {
					const st = this.statusValue.state;
					if (st === "revoked" || st === "rotation_rejected" || st === "needs_unlock") return;
					this.backoffMs = Math.min(Math.max(this.backoffMs * 2, 2000), 5 * 60_000);
					this.schedule(jitter(this.backoffMs));
				});
		}, ms);
	}

	private connect(): void {
		if (this.stopped) return;
		const ws = new WebSocket(this.o.vault.api.eventsUrl(), { headers: { authorization: `Bearer ${this.o.vault.token}` } });
		this.ws = ws;
		ws.on("message", (data) => {
			try {
				const ev = JSON.parse(String(data)) as { type: string };
				if (ev.type === "change" || ev.type === "keys") this.schedule(50);
				if (ev.type === "revoked" || ev.type === "deleted") this.setStatus({ state: "revoked", error: `this device was ${ev.type}` });
			} catch {
				// ignore malformed notices
			}
		});
		let unauthorized = false;
		ws.on("unexpected-response", (_req, res) => {
			if (res.statusCode === 401) {
				unauthorized = true;
				this.setStatus({ state: "revoked", error: "this device is signed out or revoked" });
			}
			res.resume();
		});
		ws.on("close", () => {
			const st = this.statusValue.state;
			if (unauthorized || st === "revoked" || st === "needs_unlock" || st === "rotation_rejected") return;
			if (this.ws === ws && !this.stopped) setTimeout(() => this.connect(), jitter(5000));
		});
		ws.on("error", () => ws.close());
	}

	/** For tests and diagnostics. */
	snapshot(): { state: EngineState; outbox: OutboxEntry[] } {
		return { state: structuredClone(this.state), outbox: [...this.outbox] };
	}
}

export { toHex };
