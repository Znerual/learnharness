// Node side of the Android Keystore bridge (vault issue #46). Copied from learnharness-vault
// integration/android/keystorage-android.ts; keep the two in step.
//
// Node runs inside the app process (JNI), so there is no child IPC. The Kotlin shell serves
// `KeystoreServer` on 127.0.0.1 (random port) and passes its URL as LH_KEYSTORE_URL; the bearer
// token is the per-launch LH_DESKTOP_API_SECRET, as for the speech server. The Keystore only wraps:
// this adapter keeps the wrapped blob `0x01 || iv(12) || ciphertext || tag(16)` in
// `files/local/vault/secrets.enc`.
//
// Contract with KeystoreServer.kt (all bodies are text/plain base64, no JSON on the happy path):
//   POST /keystore/status  -> 200 {"available":bool,"level":"strongbox"|"tee"|"software","reason"?:string}
//   POST /keystore/wrap    base64(plaintext) -> 200 base64(blob)      | 503 {"error":"unavailable","reason"}
//   POST /keystore/unwrap  base64(blob)      -> 200 base64(plaintext) | 409 {"error":"corrupt"} | 503
//   POST /keystore/delete  -> 200 {}
//   401 for a missing or wrong bearer secret, 400 for a bad body.

import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
	decodeBundle, encodeBundle, KeyStorageError,
	type KeyStorage, type KeyStorageStatus, type NoSecureStorageReason, type SecretBundle,
} from "@znerual/learnharness-vault-client";

export const BLOB_VERSION = 0x01;
const MIN_BLOB = 1 + 12 + 16 + 1;

export interface AndroidKeyStorageOptions {
	/** e.g. http://127.0.0.1:41873 (LH_KEYSTORE_URL). Undefined when the shell has no bridge. */
	url: string | undefined;
	/** LH_DESKTOP_API_SECRET */
	secret: string | undefined;
	/** `<files>/local/vault/secrets.enc` */
	file: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

export class AndroidKeyStorage implements KeyStorage {
	private readonly o: AndroidKeyStorageOptions;
	constructor(o: AndroidKeyStorageOptions) {
		this.o = o;
	}

	static fromEnv(env: Readonly<Record<string, string | undefined>>, localDir: string = env["LH_LOCAL_DIR"] ?? ""): AndroidKeyStorage {
		return new AndroidKeyStorage({ url: env["LH_KEYSTORE_URL"], secret: env["LH_DESKTOP_API_SECRET"], file: `${localDir}/vault/secrets.enc` });
	}

	private get configured(): boolean {
		return !!this.o.url && !!this.o.secret;
	}

	async status(): Promise<KeyStorageStatus> {
		if (!this.configured) return { available: false, reason: "bridge_missing" };
		let res: Response;
		try {
			res = await this.post("status", "");
		} catch {
			return { available: false, reason: "bridge_missing" };
		}
		if (!res.ok) return { available: false, reason: "bridge_missing" };
		const j = (await res.json().catch(() => null)) as { available?: boolean; level?: string; reason?: string } | null;
		if (!j) return { available: false, reason: "bridge_missing" };
		if (j.available === true && (j.level === "strongbox" || j.level === "tee" || j.level === "software")) {
			// "software" is reported as available only by debug builds of the shell.
			return j.level === "strongbox"
				? { available: true, protection: "keystore-strongbox", backend: "strongbox" }
				: { available: true, protection: "keystore-tee", backend: j.level === "tee" ? "tee" : "software-debug" };
		}
		return { available: false, reason: toReason(j.reason), backend: j.level ?? "unknown" };
	}

	async load(): Promise<SecretBundle | null> {
		let blob: Buffer;
		try {
			blob = await readFile(this.o.file);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new KeyStorageError("io", (e as Error).message);
		}
		if (blob.length < MIN_BLOB || blob[0] !== BLOB_VERSION) throw new KeyStorageError("corrupt", "wrapped key bundle has an invalid header");
		const plain = await this.call("unwrap", blob.toString("base64"));
		return decodeBundle(Buffer.from(plain, "base64").toString("utf8"));
	}

	async save(bundle: SecretBundle): Promise<void> {
		const blobB64 = await this.call("wrap", Buffer.from(encodeBundle(bundle), "utf8").toString("base64"));
		const blob = Buffer.from(blobB64, "base64");
		if (blob.length < MIN_BLOB || blob[0] !== BLOB_VERSION) throw new KeyStorageError("io", "keystore returned an invalid blob");
		const tmp = `${this.o.file}.tmp-${process.pid}`;
		try {
			await mkdir(dirname(this.o.file), { recursive: true, mode: 0o700 });
			const fh = await open(tmp, "w", 0o600);
			try {
				await fh.writeFile(blob);
				await fh.sync();
			} finally {
				await fh.close();
			}
			await chmod(tmp, 0o600);
			await rename(tmp, this.o.file);
		} catch (e) {
			await rm(tmp, { force: true }).catch(() => {});
			throw new KeyStorageError("io", (e as Error).message);
		}
	}

	async clear(): Promise<void> {
		try {
			await rm(this.o.file, { force: true });
		} catch (e) {
			throw new KeyStorageError("io", (e as Error).message);
		}
		// Drop the wrapping key too, so a signed-out device holds nothing; best effort.
		if (this.configured) await this.post("delete", "").catch(() => {});
	}

	private post(op: "status" | "wrap" | "unwrap" | "delete", body: string): Promise<Response> {
		const f = this.o.fetch ?? fetch;
		return f(`${this.o.url}/keystore/${op}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.o.secret}`, "content-type": "text/plain" },
			body,
			signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
		});
	}

	private async call(op: "wrap" | "unwrap", body: string): Promise<string> {
		if (!this.configured) throw new KeyStorageError("no_secure_storage", "bridge_missing");
		let res: Response;
		try {
			res = await this.post(op, body);
		} catch (e) {
			throw new KeyStorageError("io", `keystore bridge unreachable: ${(e as Error).message}`);
		}
		const text = await res.text();
		if (res.ok) return text.trim();
		const err = (() => { try { return JSON.parse(text) as { error?: string; reason?: string }; } catch { return {}; } })() as { error?: string; reason?: string };
		if (res.status === 409) throw new KeyStorageError("corrupt", `keystore cannot ${op}: ${err.error ?? "corrupt"}`);
		if (res.status === 503) throw new KeyStorageError("no_secure_storage", `keystore unavailable: ${err.reason ?? "unavailable"}`);
		if (res.status === 401) throw new KeyStorageError("io", "keystore bridge rejected the secret");
		throw new KeyStorageError("io", `keystore ${op} failed with HTTP ${res.status}`);
	}
}

function toReason(r: string | undefined): NoSecureStorageReason {
	return r === "software_only" ? "software_only" : "unsupported_platform";
}
