// Point-in-time restore (ADR 0010, #34). A restore is a forward write: chosen versions are
// written as new versions on top of the current heads. History is never rewritten. Segments
// are append-only and never restored.

import type { ChangeRow } from "./api/types.ts";
import { decryptRecord, recordId, vaultKeyFor } from "./crypto/index.ts";
import { isDocumentPath } from "./sync/mapping.ts";
import type { SyncEngine } from "./sync/engine.ts";
import type { SyncHost } from "./sync/host.ts";
import type { Vault } from "./vault.ts";

export interface Version {
	seq: number;
	createdAt: string;
	deviceName: string;
	deleted: boolean;
	size: number;
}

export interface RestorePlanEntry {
	path: string;
	change: "changed" | "added" | "removed";
	/** The version to write; null means write a tombstone (the document did not exist then). */
	target: ChangeRow | null;
}

/** Decrypts a version. Deletion comes only from the authenticated header, never from ChangeRow.tombstone. */
async function open(vault: Vault, c: ChangeRow): Promise<{ path: string; body: Uint8Array; deleted: boolean; kind: "doc" | "seg" } | null> {
	const keys = vault.keys;
	const env = await vault.api.blob(c.sha256, vault.auth());
	const r = decryptRecord(keys.accountId, keys.ik, c.recordId, c.kind, env, (e) => vaultKeyFor(keys, e));
	if (r.header.kind !== "doc" || !isDocumentPath(r.header.path)) return null;
	return { path: r.header.path, body: r.body, deleted: r.header.deleted, kind: r.header.kind };
}

export class Restorer {
	/** Record ids the server offered that are not synced documents; skipped by preview and restore. */
	readonly skipped: string[] = [];

	constructor(private readonly vault: Vault, private readonly engine: SyncEngine, private readonly host: SyncHost) {}

	/** Lists the versions of one document (newest first), within the 90-day history. */
	async versions(path: string): Promise<Version[]> {
		const id = recordId(this.vault.keys.ik, path);
		const r = await this.vault.api.get<{ versions: ChangeRow[] }>(`/v1/history/${id}`, this.vault.auth());
		return r.versions.map((v) => ({ seq: v.seq, createdAt: v.createdAt, deviceName: v.deviceName, deleted: v.tombstone, size: v.size }));
	}

	/** Restores one document to an earlier version, as a new version on top of the head. */
	async restoreVersion(path: string, seq: number): Promise<void> {
		const id = recordId(this.vault.keys.ik, path);
		const r = await this.vault.api.get<{ versions: ChangeRow[] }>(`/v1/history/${id}`, this.vault.auth());
		const v = r.versions.find((x) => x.seq === seq);
		if (!v) throw new Error(`no version ${seq} of ${path}`);
		const o = await open(this.vault, v);
		if (!o || o.path !== path) throw new Error(`version ${seq} of ${path} is not a valid document version`);
		await this.write(path, o.deleted ? null : o.body);
		await this.engine.sync();
	}

	/** Which documents a whole-vault restore to `at` would change, add or remove. */
	async preview(at: Date): Promise<RestorePlanEntry[]> {
		const auth = this.vault.auth();
		const then = (await this.vault.api.get<{ records: ChangeRow[] }>(`/v1/history?at=${encodeURIComponent(at.toISOString())}`, auth)).records.filter((r) => r.kind === "doc");
		const now = (await this.vault.api.get<{ records: ChangeRow[] }>(`/v1/history?at=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, auth)).records.filter((r) => r.kind === "doc");
		const nowById = new Map(now.map((r) => [r.recordId, r]));
		const thenById = new Map(then.map((r) => [r.recordId, r]));
		const plan: RestorePlanEntry[] = [];
		for (const t of then) {
			const n = nowById.get(t.recordId);
			if (n && n.seq === t.seq) continue;
			const o = await open(this.vault, t);
			if (!o) {
				this.skipped.push(t.recordId);
				continue;
			}
			const no = n ? await open(this.vault, n) : null;
			if (n && !no) {
				this.skipped.push(n.recordId);
				continue;
			}
			const nDeleted = !no || no.deleted;
			if (o.deleted && nDeleted) continue;
			plan.push({ path: o.path, change: o.deleted ? "removed" : nDeleted ? "added" : "changed", target: o.deleted ? null : t });
		}
		for (const n of now) {
			if (thenById.has(n.recordId)) continue;
			const o = await open(this.vault, n);
			if (!o) {
				this.skipped.push(n.recordId);
				continue;
			}
			if (o.deleted) continue;
			plan.push({ path: o.path, change: "removed", target: null });
		}
		return plan.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Restores the whole vault to `at`. Returns the applied plan. */
	async restoreTo(at: Date): Promise<RestorePlanEntry[]> {
		const plan = await this.preview(at);
		for (const p of plan) {
			const o = p.target ? await open(this.vault, p.target) : null;
			if (p.target && !o) continue;
			if (o) await this.write(p.path, o.body);
			else await this.write(p.path, null);
		}
		await this.engine.sync();
		return plan;
	}

	private async write(path: string, body: Uint8Array | null): Promise<void> {
		await this.engine.noteDocumentChanged(path); // intent first
		if (body === null) await this.host.deleteDocument(path);
		else await this.host.writeDocument(path, body);
	}
}
