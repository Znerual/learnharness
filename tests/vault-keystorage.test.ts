import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { SecretBundle } from "@znerual/learnharness-vault-client";

import { attachKeyStorageChild, createKeyStorageService, validateRequest } from "../electron/keystorage-main.cjs";
import type { IpcProcess } from "../src/server/vault/keystorage-ipc.ts";
import { fakeSafeStorage, type FakeOptions } from "./vault-fake-safe-storage.ts";
import { hasVaultClient, loadIfVaultClient } from "./vault-helpers.ts";

// The bridge's server side needs the private vault client (KeyStorageError, bundle encoding); skipped without it.
const { decodeBundle, encodeBundle } = await loadIfVaultClient<typeof import("@znerual/learnharness-vault-client")>("@znerual/learnharness-vault-client");
const { IpcKeyStorage } = await loadIfVaultClient<typeof import("../src/server/vault/keystorage-ipc.ts")>("../src/server/vault/keystorage-ipc.ts");

const childPath = fileURLToPath(new URL("./vault-keystorage-child.ts", import.meta.url));
const dirs: string[] = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const bundle: SecretBundle = {
	accountId: "acc", serverUrl: "https://vault.example.test", deviceId: "dev", deviceToken: "tok",
	deviceSeed: new Uint8Array(32).fill(7), deviceMethodId: "m1", generation: 3,
	rootKey: new Uint8Array(32).fill(1), ik: new Uint8Array(32).fill(2), vaultKeys: [new Uint8Array(32).fill(3)],
	highWater: { generation: 3, epoch: 1 },
	pins: {},
	consumedMethods: [],
};

interface Result { ok: boolean; value?: any; code?: string }
interface Rig { call(cmd: string, arg?: string): Promise<Result>; file: string; fake: ReturnType<typeof fakeSafeStorage>; stop(): Promise<void> }

async function rig(opts: FakeOptions, platform: NodeJS.Platform = "linux"): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "lhv-ks-"));
	dirs.push(dir);
	const file = join(dir, "vault-secrets.bin");
	const fake = fakeSafeStorage(opts);
	const child: ChildProcess = fork(childPath, { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
	const handle = attachKeyStorageChild(child, createKeyStorageService({ safeStorage: fake, filePath: file, platform }));
	let n = 0;
	const waiting = new Map<number, (m: Result) => void>();
	child.on("message", (m: any) => { if (m?.channel === "test:res") waiting.get(m.id)?.(m); });
	let stopped: Promise<void> | null = null;
	return {
		file, fake,
		call: (cmd, arg) => new Promise((resolve) => {
			const id = ++n;
			waiting.set(id, resolve);
			child.send({ channel: "test:cmd", id, cmd, arg });
		}),
		stop: () => (stopped ??= new Promise<void>((resolve) => { handle.dispose(); child.once("exit", () => resolve()); child.kill(); })),
	};
}

describe("lh:keystorage bridge through a real child_process.fork", { skip: !hasVaultClient && "the vault client package is not installed" }, () => {
	it("round-trips a bundle and writes a 0600 file", async () => {
		const r = await rig({});
		try {
			const st = await r.call("status");
			assert.deepEqual(st.value, { available: true, protection: "os-keyring", backend: "gnome_libsecret" });
			assert.equal((await r.call("load")).value, null);
			assert.equal((await r.call("save", encodeBundle(bundle))).ok, true);
			assert.equal((await stat(r.file)).mode & 0o777, 0o600);
			const raw = await readFile(r.file);
			assert.ok(!raw.toString("latin1").includes("rootKey"), "file must not hold plaintext JSON");
			assert.deepEqual(decodeBundle((await r.call("load")).value), bundle);
			assert.equal((await r.call("clear")).ok, true);
			assert.equal((await r.call("clear")).ok, true, "clear is idempotent");
			assert.equal((await r.call("load")).value, null);
		} finally { await r.stop(); }
	});

	it("save replaces the bundle atomically and leaves no temp file", async () => {
		const r = await rig({});
		try {
			await r.call("save", encodeBundle(bundle));
			await r.call("save", encodeBundle({ ...bundle, generation: 4 }));
			assert.equal(decodeBundle((await r.call("load")).value).generation, 4);
			assert.deepEqual(await readdir(join(r.file, "..")), ["vault-secrets.bin"]);
		} finally { await r.stop(); }
	});

	it("corrupt file header -> corrupt", async () => {
		const r = await rig({});
		try {
			await writeFile(r.file, "garbage-not-a-bundle");
			const res = await r.call("load");
			assert.equal(res.ok, false);
			assert.equal(res.code, "corrupt");
		} finally { await r.stop(); }
	});

	it("keyring key lost (undecryptable ciphertext) -> corrupt", async () => {
		const r = await rig({});
		try {
			await r.call("save", encodeBundle(bundle));
			r.fake.keyId = 2; // the keyring item was deleted and recreated
			assert.equal((await r.call("load")).code, "corrupt");
		} finally { await r.stop(); }
	});

	it("decrypts fine but the JSON is garbage -> corrupt", async () => {
		const r = await rig({});
		try {
			const ct = await r.fake.encryptStringAsync("not json");
			await writeFile(r.file, Buffer.concat([Buffer.from("LHVS\x01", "latin1"), ct]));
			const res = await r.call("load");
			assert.equal(res.ok, false);
			assert.equal(res.code, "corrupt");
		} finally { await r.stop(); }
	});

	it("Linux: refuses basic_text", async () => {
		const r = await rig({ backend: "basic_text", available: false });
		try {
			assert.deepEqual((await r.call("status")).value, { available: false, reason: "no_keyring", backend: "basic_text" });
			assert.equal((await r.call("save", encodeBundle(bundle))).code, "no_secure_storage");
			assert.equal(r.fake.encrypted, 0);
		} finally { await r.stop(); }
	});

	it("Linux: refuses basic_text even when the async API fails open (v10)", async () => {
		const r = await rig({ backend: "basic_text", available: true, prefix: "v10" });
		try {
			assert.equal((await r.call("status")).value.available, false);
			assert.equal((await r.call("save", encodeBundle(bundle))).code, "no_secure_storage");
		} finally { await r.stop(); }
	});

	it("Linux: refuses v10 ciphertext although the backend name looks fine (no D-Bus)", async () => {
		const r = await rig({ backend: "gnome_libsecret", available: true, prefix: "v10" });
		try {
			assert.deepEqual((await r.call("status")).value, { available: false, reason: "no_keyring", backend: "gnome_libsecret" });
			assert.equal((await r.call("save", encodeBundle(bundle))).code, "no_secure_storage");
			await assert.rejects(readFile(r.file), /ENOENT/);
		} finally { await r.stop(); }
	});

	it("Linux: accepts v11 with gnome_libsecret and kwallet6", async () => {
		for (const backend of ["gnome_libsecret", "kwallet6"]) {
			const r = await rig({ backend, prefix: "v11" });
			try {
				const st = await r.call("status");
				assert.equal(st.value.available, true);
				assert.equal(st.value.backend, backend);
			} finally { await r.stop(); }
		}
	});

	it("Linux: a locked keyring maps to locked", async () => {
		const r = await rig({ throwOnEncrypt: "keyring is locked" });
		try {
			assert.equal((await r.call("status")).value.reason, "keyring_locked");
			assert.equal((await r.call("save", encodeBundle(bundle))).code, "locked");
		} finally { await r.stop(); }
	});

	it("an existing file with an unavailable keyring reports no_secure_storage, not null", async () => {
		const a = await rig({});
		let saved: Buffer;
		try {
			await a.call("save", encodeBundle(bundle));
			saved = await readFile(a.file);
		} finally { await a.stop(); }
		const b = await rig({ backend: "basic_text", available: false });
		try {
			await writeFile(b.file, saved);
			assert.equal((await b.call("load")).code, "no_secure_storage");
		} finally { await b.stop(); }
	});

	it("macOS and Windows: available without a backend allowlist", async () => {
		for (const [platform, backend] of [["darwin", "keychain"], ["win32", "dpapi"]] as const) {
			const r = await rig({ prefix: "v10" }, platform);
			try {
				assert.deepEqual((await r.call("status")).value, { available: true, protection: "os-keyring", backend });
				assert.equal((await r.call("save", encodeBundle(bundle))).ok, true);
				assert.deepEqual(decodeBundle((await r.call("load")).value), bundle);
			} finally { await r.stop(); }
		}
	});

	it("other platforms: unsupported_platform", async () => {
		const r = await rig({}, "freebsd");
		try { assert.equal((await r.call("status")).value.reason, "unsupported_platform"); } finally { await r.stop(); }
	});
});

describe("missing bridge", { skip: !hasVaultClient && "the vault client package is not installed" }, () => {
	it("a process without an IPC channel reports unavailable bridge_missing", async () => {
		const out = await new Promise<string>((resolve, reject) => {
			const c = spawn(process.execPath, ["--import", "tsx", childPath], { stdio: ["ignore", "pipe", "inherit"] });
			let s = "";
			c.stdout.on("data", (d) => (s += d));
			c.on("exit", () => resolve(s));
			c.on("error", reject);
		});
		assert.deepEqual(JSON.parse(out), { available: false, reason: "bridge_missing" });
	});

	it("load/save fail with no_secure_storage, clear is a no-op", async () => {
		const ks = new IpcKeyStorage({ proc: { on() {}, removeListener() {} } as IpcProcess });
		assert.deepEqual(await ks.status(), { available: false, reason: "bridge_missing" });
		await assert.rejects(ks.load(), { code: "no_secure_storage" });
		await assert.rejects(ks.save(bundle), { code: "no_secure_storage" });
		await ks.clear();
	});
});

describe("IpcKeyStorage transport", { skip: !hasVaultClient && "the vault client package is not installed" }, () => {
	it("times out with io when the main process never answers", async () => {
		const proc: IpcProcess = { connected: true, send: () => true, on() {}, removeListener() {} };
		await assert.rejects(new IpcKeyStorage({ proc, timeoutMs: 30 }).load(), { code: "io" });
	});

	it("ignores replies with the wrong channel or unknown id and rejects on disconnect", async () => {
		const h: Record<string, (m?: unknown) => void> = {};
		const proc: IpcProcess = {
			connected: true,
			send: (m: any) => {
				h["message"]?.({ channel: "other", id: m.id, ok: true, value: null });
				h["message"]?.({ channel: "lh:keystorage", id: "nope", ok: true, value: null });
				setTimeout(() => h["disconnect"]?.(), 5);
				return true;
			},
			on: (e, l) => { h[e] = l; }, removeListener() {},
		};
		await assert.rejects(new IpcKeyStorage({ proc, timeoutMs: 2000 }).load(), { code: "io", message: "IPC channel closed" });
	});

	it("maps a reply error code, and an unknown code becomes io", async () => {
		for (const [sent, want] of [["locked", "locked"], ["weird", "io"]] as const) {
			const h: Record<string, (m?: unknown) => void> = {};
			const proc: IpcProcess = {
				connected: true,
				send: (m: any) => { setImmediate(() => h["message"]?.({ channel: "lh:keystorage", id: m.id, ok: false, error: { code: sent, message: "x" } })); return true; },
				on: (e, l) => { h[e] = l; }, removeListener() {},
			};
			await assert.rejects(new IpcKeyStorage({ proc }).load(), { code: want });
		}
	});
});

describe("request validation", () => {
	it("accepts the four ops and rejects malformed requests", () => {
		for (const op of ["status", "load", "clear"]) assert.equal(validateRequest({ channel: "lh:keystorage", id: "1", op }), null);
		assert.equal(validateRequest({ channel: "lh:keystorage", id: "1", op: "save", bundle: "{}" }), null);
		assert.equal(validateRequest({ channel: "lh:keystorage", id: "1", op: "save" }), "bundle");
		assert.equal(validateRequest({ channel: "lh:keystorage", id: "1", op: "save", bundle: "" }), "bundle");
		assert.equal(validateRequest({ channel: "lh:keystorage", id: "1", op: "delete" }), "op");
		assert.equal(validateRequest({ channel: "lh:keystorage", id: 1, op: "load" }), "id");
		assert.equal(validateRequest({ channel: "lh:other", id: "1", op: "load" }), "channel");
		assert.equal(validateRequest(null), "channel");
	});
});
