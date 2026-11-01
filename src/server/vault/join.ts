// First-device seeding and joining with existing local data (#38, ADR 0007 "Joining with existing local data").

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { crypto as vaultCrypto, parseLedgerFile, type ChangesResponse, type SyncEngine, type SyncReport, type Vault } from "@znerual/learnharness-vault-client";

import type { LearnHarnessHost } from "./host.ts";

export class VaultNotEmptyError extends Error {
	readonly code = "vault_not_empty";
	constructor() {
		super("The vault already holds records. Sign in with \"Use the vault\" (joinWithExistingData) instead of seeding it.");
		this.name = "VaultNotEmptyError";
	}
}

export async function vaultIsEmpty(vault: Vault): Promise<boolean> {
	const r = (await vault.api.get("/v1/changes?since=0&limit=1", vault.auth())) as ChangesResponse;
	return r.changes.length === 0;
}

/**
 * The first device seeds the vault with its whole data folder, including the pre-split shared base
 * ledgers (ADR 0007). Refuses a vault that already holds records. Returns the number of records
 * queued and the sync report.
 */
export async function seedFirstDevice(o: { vault: Vault; engine: SyncEngine }): Promise<{ queued: number; report: SyncReport }> {
	if (!(await vaultIsEmpty(o.vault))) throw new VaultNotEmptyError();
	const queued = await o.engine.seedAll();
	return { queued, report: await o.engine.sync() };
}

// ---------------------------------------------------------------- the vault's own segments

function sha256Hex(b: Uint8Array): string {
	return createHash("sha256").update(b).digest("hex");
}

/**
 * The bytes the vault holds for this device's own ledger files, per file, from offset 0 up to the
 * first gap. The engine skips segments of the own device while pulling (the local file is the
 * source), so joining reads them itself.
 */
export async function fetchOwnLedgerBytes(vault: Vault, deviceId: string): Promise<Map<string, Uint8Array>> {
	const parts = new Map<string, { offset: number; body: Uint8Array }[]>();
	let since = 0;
	for (;;) {
		const ch = (await vault.api.get(`/v1/changes?since=${since}&limit=500`, vault.auth())) as ChangesResponse;
		if (ch.generation !== vault.keys.generation) await vault.refreshKeys();
		for (const c of ch.changes) {
			if (c.kind !== "seg") continue;
			const keys = vault.keys;
			const env = await vault.api.blob(c.sha256, vault.auth());
			if (sha256Hex(env) !== c.sha256) throw new Error(`blob ${c.sha256} does not match its hash`);
			const { header, body } = vaultCrypto.decryptRecord(keys.accountId, keys.ik, c.recordId, "seg", env, (e: number) => vaultCrypto.vaultKeyFor(keys, e));
			if (header.kind !== "seg") continue;
			const m = /^ledger\/([a-z][a-z0-9_-]*)\/(dev_[a-z0-9]{8})\/\d{12}$/.exec(header.path);
			if (!m || m[2] !== deviceId) continue;
			const file = `graph/${m[1]}.${deviceId}.jsonl`;
			parts.set(file, [...(parts.get(file) ?? []), { offset: header.offset, body }]);
		}
		since = ch.cursor;
		if (!ch.more) break;
	}
	const out = new Map<string, Uint8Array>();
	for (const [file, segs] of parts) {
		segs.sort((a, b) => a.offset - b.offset);
		const chunks: Uint8Array[] = [];
		let end = 0;
		for (const s of segs) {
			if (s.offset > end) break; // a gap: only the prefix is usable
			if (s.offset + s.body.length > end) {
				chunks.push(s.body.subarray(end - s.offset));
				end = s.offset + s.body.length;
			}
		}
		out.set(file, Buffer.concat(chunks));
	}
	return out;
}

// ---------------------------------------------------------------- joining

function moveFile(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
		cpSync(from, to);
		rmSync(from, { force: true });
	}
}

function dateStamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
}

export interface JoinResult {
	cancelled: boolean;
	/** Own ledger files that stayed and are uploaded (only the rest, when the vault held a prefix). */
	keptLedgers: string[];
	/** Own ledger files rebuilt from the vault after they were moved aside. */
	restoredLedgers: string[];
	/** Files moved aside, relative to the data folder. */
	movedAside: string[];
	/** Where they went: <localDir>/pre-vault-<date>[-n]; null when nothing moved. */
	preVaultDir: string | null;
	report: SyncReport | null;
}

/**
 * A device with a non-empty data folder signs in to an existing vault and chooses "Use the vault"
 * (or "cancel", which touches nothing). The ADR rules, exactly:
 *
 * - This device's own ledger files (`graph/<ledger>.<thisDeviceId>.jsonl`) stay and are uploaded,
 *   because no other device writes them. When the vault already holds segments for this device
 *   id, the local file must start with exactly those bytes; then only the rest is uploaded.
 *   Otherwise the file is moved aside like a document.
 * - Every other file (documents, shared base ledgers, other devices' ledger files) moves to
 *   `<local>/pre-vault-<date>/` and the vault's versions are downloaded by the following sync.
 *
 * A moved-aside own ledger file is rebuilt from the vault's segments so later appends continue
 * after the vault's bytes instead of colliding at offset 0. The engine must be `init()`ed and
 * not running (`stop()` before joining).
 */
export async function joinWithExistingData(o: {
	vault: Vault;
	engine: SyncEngine;
	host: LearnHarnessHost;
	deviceId: string;
	choice: "use-vault" | "cancel";
	now?: () => Date;
}): Promise<JoinResult> {
	const result: JoinResult = { cancelled: false, keptLedgers: [], restoredLedgers: [], movedAside: [], preVaultDir: null, report: null };
	if (o.choice === "cancel") return { ...result, cancelled: true };
	const { host } = o;
	const files = await host.listAllFiles();
	const own = new Set(files.filter((f) => parseLedgerFile(f)?.owner === o.deviceId));
	const vaultOwn = await fetchOwnLedgerBytes(o.vault, o.deviceId);

	const keep = new Map<string, number>(); // own ledger file -> bytes already in the vault
	for (const file of own) {
		const theirs = vaultOwn.get(file);
		if (!theirs || theirs.length === 0) {
			keep.set(file, 0);
			continue;
		}
		const local = readFileSync(join(host.root, file));
		if (local.length >= theirs.length && local.subarray(0, theirs.length).equals(theirs)) keep.set(file, theirs.length);
	}

	const moving = files.filter((f) => !keep.has(f));
	if (moving.length > 0) {
		const base = `pre-vault-${dateStamp(o.now?.() ?? new Date())}`;
		let dir = join(host.localDir, base);
		for (let i = 2; existsSync(dir); i++) dir = join(host.localDir, `${base}-${i}`);
		for (const f of moving) moveFile(join(host.root, f), join(dir, f));
		result.movedAside = moving;
		result.preVaultDir = dir;
	}

	// Own ledgers that exist in the vault but not (validly) locally: rebuild them from the vault.
	for (const [file, bytes] of vaultOwn) {
		if (keep.has(file) || bytes.length === 0) continue;
		const p = join(host.root, file);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, bytes);
		await o.engine.adoptLedgerPushed(file, bytes.length);
		result.restoredLedgers.push(file);
	}
	for (const [file, pushed] of keep) {
		if (pushed > 0) await o.engine.adoptLedgerPushed(file, pushed);
		await o.engine.noteLedgerAppended(file, pushed);
		result.keptLedgers.push(file);
	}
	result.report = await o.engine.sync();
	return result;
}
