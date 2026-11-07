// KeyStorage port (spike #4, ADR 0003 "Device storage"). The adapters (Electron safeStorage
// bridge, Android Keystore bridge) live in the host; the package ships an in-memory store for
// session mode and an unprotected file store for the explicit opt-in.

import { chmod, mkdir, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { fromB64, toB64 } from "./crypto/bytes.ts";

/** Everything a signed-in device keeps secret, saved and replaced as one unit. */
export interface SecretBundle {
	readonly accountId: string;
	readonly serverUrl: string;
	readonly deviceId: string;
	/** Vault device token (bearer). */
	readonly deviceToken: string;
	/** Seed of the `device` unlock method; null for an ephemeral device. */
	readonly deviceSeed: Uint8Array | null;
	readonly deviceMethodId: string | null;
	/** ARK_g and the keys it unwrapped, so rotation acceptance can compare (ADR 0002 rule 2). */
	readonly generation: number;
	readonly rootKey: Uint8Array;
	readonly ik: Uint8Array;
	readonly vaultKeys: readonly Uint8Array[];
	/** Highest generation and epoch accepted (rule 3). */
	readonly highWater: { readonly generation: number; readonly epoch: number };
	/** Pinned unlock-method public keys (ADR 0002 rule 5): method id to base64url public key. Missing = none (v1 bundle). */
	readonly pins?: Readonly<Record<string, string>>;
	/** Public keys (base64url) of backup codes this device saw consumed; never pinned or sealed to again. */
	readonly consumedMethods?: readonly string[];
}

export type Protection = "os-keyring" | "keystore-tee" | "keystore-strongbox" | "memory" | "file-unprotected";

export type NoSecureStorageReason = "no_keyring" | "keyring_locked" | "bridge_missing" | "software_only" | "unsupported_platform";

export type KeyStorageStatus =
	| { readonly available: true; readonly protection: Protection; readonly backend: string }
	| { readonly available: false; readonly reason: NoSecureStorageReason; readonly backend?: string };

export type KeyStorageErrorCode = "no_secure_storage" | "locked" | "corrupt" | "io";

export class KeyStorageError extends Error {
	readonly code: KeyStorageErrorCode;
	constructor(code: KeyStorageErrorCode, message?: string) {
		super(message ?? code);
		this.name = "KeyStorageError";
		this.code = code;
	}
}

export interface KeyStorage {
	status(): Promise<KeyStorageStatus>;
	/** null when nothing is stored (signed out). */
	load(): Promise<SecretBundle | null>;
	/** Replaces the bundle atomically. */
	save(bundle: SecretBundle): Promise<void>;
	/** Deletes the bundle. Idempotent. */
	clear(): Promise<void>;
}

/** Session mode: keys live only in memory; the learner unlocks on every launch. */
export class MemoryKeyStorage implements KeyStorage {
	private bundle: SecretBundle | null = null;
	async status(): Promise<KeyStorageStatus> {
		return { available: true, protection: "memory", backend: "memory" };
	}
	async load(): Promise<SecretBundle | null> {
		return this.bundle;
	}
	async save(bundle: SecretBundle): Promise<void> {
		this.bundle = bundle;
	}
	async clear(): Promise<void> {
		this.bundle = null;
	}
}

/** JSON form used by file-backed adapters (also the payload an OS-keyring adapter encrypts). */
export function encodeBundle(b: SecretBundle): string {
	return JSON.stringify({
		v: 2, accountId: b.accountId, serverUrl: b.serverUrl, deviceId: b.deviceId, deviceToken: b.deviceToken,
		deviceSeed: b.deviceSeed ? toB64(b.deviceSeed) : null, deviceMethodId: b.deviceMethodId, generation: b.generation,
		rootKey: toB64(b.rootKey), ik: toB64(b.ik), vaultKeys: b.vaultKeys.map(toB64), highWater: b.highWater,
		pins: b.pins ?? {}, consumedMethods: b.consumedMethods ?? [],
	});
}

export function decodeBundle(s: string): SecretBundle {
	try {
		const o = JSON.parse(s) as Record<string, unknown>;
		if (o["v"] !== 1 && o["v"] !== 2) throw new Error("version");
		const pins = o["pins"] === undefined ? {} : (o["pins"] as Record<string, string>);
		const consumed = o["consumedMethods"] === undefined ? [] : (o["consumedMethods"] as string[]);
		if (typeof pins !== "object" || pins === null || !Array.isArray(consumed)) throw new Error("pins");
		return {
			accountId: o["accountId"] as string, serverUrl: o["serverUrl"] as string, deviceId: o["deviceId"] as string,
			deviceToken: o["deviceToken"] as string, deviceSeed: o["deviceSeed"] ? fromB64(o["deviceSeed"] as string) : null,
			deviceMethodId: (o["deviceMethodId"] as string | null) ?? null, generation: o["generation"] as number,
			rootKey: fromB64(o["rootKey"] as string), ik: fromB64(o["ik"] as string), vaultKeys: (o["vaultKeys"] as string[]).map(fromB64),
			highWater: o["highWater"] as { generation: number; epoch: number },
			pins, consumedMethods: consumed,
		};
	} catch (e) {
		throw new KeyStorageError("corrupt", `stored key bundle is unreadable: ${(e as Error).message}`);
	}
}

/**
 * The explicit per-device opt-in of ADR 0003: the bundle in a file readable only by the user
 * (mode 0600), not protected by the OS. The device list marks such a device "keys not protected".
 */
export class UnprotectedFileKeyStorage implements KeyStorage {
	private chain: Promise<unknown> = Promise.resolve();
	constructor(private readonly path: string) {}
	async status(): Promise<KeyStorageStatus> {
		return { available: true, protection: "file-unprotected", backend: "file" };
	}
	async load(): Promise<SecretBundle | null> {
		let s: string;
		try {
			s = await readFile(this.path, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new KeyStorageError("io", (e as Error).message);
		}
		return decodeBundle(s);
	}
	/** Saves are serialized and each write uses its own temp file, so concurrent saves cannot interleave. */
	save(bundle: SecretBundle): Promise<void> {
		const run = async (): Promise<void> => {
			const tmp = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
			try {
				await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
				await writeFile(tmp, encodeBundle(bundle), { mode: 0o600 });
				const fh = await open(tmp, "r");
				await fh.sync();
				await fh.close();
				await chmod(tmp, 0o600);
				await rename(tmp, this.path);
			} catch (e) {
				await rm(tmp, { force: true }).catch(() => undefined);
				throw new KeyStorageError("io", (e as Error).message);
			}
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => undefined);
		return p;
	}
	async clear(): Promise<void> {
		await rm(this.path, { force: true });
	}
}
