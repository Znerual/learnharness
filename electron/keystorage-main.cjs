"use strict";
// Electron main process side of the `lh:keystorage` bridge (issue #65, ADR 0003 "Device storage").
//
// The LearnHarness server runs with ELECTRON_RUN_AS_NODE and cannot reach `safeStorage`, so the
// main process owns the ciphertext file and answers the server over the inherited Node child IPC
// channel (same pattern as chatgpt-ipc.cjs and subscription-ipc.cjs). Never add this channel to
// preload.cjs or hand it to a renderer.
//
// Spike #4 rules (spikes/04-key-storage/RESULTS.md):
//  - The async API fails open: without a keyring it silently encrypts with a hard-coded password
//    (`v10`). On Linux, "secure" therefore means: backend in the allowlist AND a trial encryption
//    yields `v11`.
//  - setUsePlainTextEncryption is never called.
//  - The sync API is deprecated in Electron 45 and removed in 46, so only the async API is used.
//
// `safeStorage` is injected, so everything here runs in plain Node against a fake.

const fs = require("node:fs");
const path = require("node:path");

const CHANNEL = "lh:keystorage";
const OPS = ["status", "load", "save", "clear"];
const LINUX_BACKENDS = ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"];
const MAGIC = Buffer.from("LHVS\x01", "latin1"); // file = MAGIC || safeStorage ciphertext
const MAX_BUNDLE_CHARS = 1 << 20;

/** @typedef {{code: "no_secure_storage"|"locked"|"corrupt"|"io", message: string}} PortError */

function fail(code, message) {
	return Object.assign(new Error(message || code), { keyStorageCode: code });
}

/**
 * @param {object} opts
 * @param {{isAsyncEncryptionAvailable(): Promise<boolean>, getSelectedStorageBackend?: () => string, encryptStringAsync(s: string): Promise<Buffer>, decryptStringAsync(b: Buffer): Promise<{shouldReEncrypt: boolean, result: string}>}} opts.safeStorage
 * @param {string} opts.filePath  e.g. path.join(app.getPath("userData"), "vault-secrets.bin")
 * @param {NodeJS.Platform} [opts.platform]
 */
function createKeyStorageService({ safeStorage, filePath, platform = process.platform }) {
	let cached = null; // a secure result is cached; an insecure one is re-probed (the keyring may unlock later)

	async function probe() {
		if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
			return { available: false, reason: "unsupported_platform" };
		}
		let backend = platform === "darwin" ? "keychain" : "dpapi";
		if (platform === "linux") {
			backend = typeof safeStorage.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : "unknown";
			if (!LINUX_BACKENDS.includes(backend)) return { available: false, reason: "no_keyring", backend };
		}
		try {
			if (!(await safeStorage.isAsyncEncryptionAvailable())) return { available: false, reason: platform === "linux" ? "no_keyring" : "unsupported_platform", backend };
			// Trial encryption. On Linux the prefix tells a real keyring (v11) from the hard-coded fallback (v10).
			const trial = await safeStorage.encryptStringAsync("lhv-probe");
			if (platform === "linux" && Buffer.from(trial).subarray(0, 3).toString("latin1") !== "v11") {
				return { available: false, reason: "no_keyring", backend };
			}
		} catch (e) {
			return { available: false, reason: /lock/i.test(String(e && e.message)) ? "keyring_locked" : "no_keyring", backend };
		}
		return { available: true, protection: "os-keyring", backend };
	}

	async function status() {
		if (cached) return cached;
		const s = await probe();
		if (s.available) cached = s;
		return s;
	}

	async function requireSecure() {
		const s = await status();
		if (!s.available) throw fail(s.reason === "keyring_locked" ? "locked" : "no_secure_storage", `secure storage unavailable: ${s.reason}`);
	}

	async function load() {
		let raw;
		try {
			raw = await fs.promises.readFile(filePath);
		} catch (e) {
			if (e && e.code === "ENOENT") return null;
			throw fail("io", e.message);
		}
		if (raw.length <= MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw fail("corrupt", "stored key bundle has no valid header");
		await requireSecure();
		try {
			const out = await safeStorage.decryptStringAsync(raw.subarray(MAGIC.length));
			if (typeof out.result !== "string" || out.result === "") throw new Error("empty plaintext");
			return out.result;
		} catch (e) {
			// Wrong or deleted keyring key, damaged ciphertext, profile reset: the bundle is gone.
			throw fail("corrupt", `stored key bundle cannot be decrypted: ${e && e.message}`);
		}
	}

	let saveChain = Promise.resolve();
	function save(bundle) {
		const p = saveChain.then(() => saveNow(bundle), () => saveNow(bundle));
		saveChain = p.catch(() => {});
		return p;
	}

	async function saveNow(bundle) {
		if (typeof bundle !== "string" || bundle.length === 0 || bundle.length > MAX_BUNDLE_CHARS) throw fail("io", "invalid bundle");
		await requireSecure();
		let ct;
		try {
			ct = await safeStorage.encryptStringAsync(bundle);
		} catch (e) {
			throw fail("no_secure_storage", `encryption failed: ${e && e.message}`);
		}
		if (platform === "linux" && Buffer.from(ct).subarray(0, 3).toString("latin1") !== "v11") {
			cached = null;
			throw fail("no_secure_storage", "refusing ciphertext that is not keyring-backed (v11)");
		}
		const data = Buffer.concat([MAGIC, Buffer.from(ct)]);
		const tmp = `${filePath}.tmp-${process.pid}-${require("node:crypto").randomUUID()}`;
		try {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
			const fh = await fs.promises.open(tmp, "w", 0o600);
			try {
				await fh.writeFile(data);
				await fh.sync();
			} finally {
				await fh.close();
			}
			await fs.promises.chmod(tmp, 0o600);
			await fs.promises.rename(tmp, filePath);
		} catch (e) {
			await fs.promises.rm(tmp, { force: true }).catch(() => {});
			throw fail("io", e.message);
		}
	}

	async function clear() {
		try {
			await fs.promises.rm(filePath, { force: true });
		} catch (e) {
			throw fail("io", e.message);
		}
	}

	return { status, load, save, clear };
}

/** Request validation, kept pure for tests. Returns an error string or null. */
function validateRequest(message) {
	if (!message || typeof message !== "object" || message.channel !== CHANNEL) return "channel";
	if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > 64) return "id";
	if (!OPS.includes(message.op)) return "op";
	if (message.op === "save" && (typeof message.bundle !== "string" || message.bundle.length === 0 || message.bundle.length > MAX_BUNDLE_CHARS)) return "bundle";
	return null;
}

/**
 * Serves one server child. The caller keeps the returned handle and calls dispose() when the
 * child exits. Messages for other channels are ignored; a malformed request for this channel gets
 * an error reply when it carries an id.
 */
function attachKeyStorageChild(child, service) {
	let disposed = false;
	const send = (packet) => {
		if (!disposed && child.connected) {
			try { child.send(packet, () => {}); } catch { /* child exited */ }
		}
	};
	const listener = async (message) => {
		if (disposed || !child.connected || !message || message.channel !== CHANNEL) return;
		const bad = validateRequest(message);
		if (bad) {
			if (typeof message.id === "string") send({ channel: CHANNEL, id: message.id, op: message.op, ok: false, error: { code: "io", message: `bad request: ${bad}` } });
			return;
		}
		const { id, op } = message;
		try {
			const value = op === "status" ? await service.status()
				: op === "load" ? await service.load()
				: op === "save" ? (await service.save(message.bundle), null)
				: (await service.clear(), null);
			send({ channel: CHANNEL, id, op, ok: true, value });
		} catch (e) {
			// Only the port's code and a short message leave this process; never the bundle.
			const code = e && e.keyStorageCode ? e.keyStorageCode : "io";
			send({ channel: CHANNEL, id, op, ok: false, error: { code, message: String(e && e.message).slice(0, 200) } });
		}
	};
	child.on("message", listener);
	return { dispose() { disposed = true; child.removeListener("message", listener); } };
}

module.exports = { CHANNEL, LINUX_BACKENDS, createKeyStorageService, attachKeyStorageChild, validateRequest };
