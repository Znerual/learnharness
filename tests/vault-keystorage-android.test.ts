import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { SecretBundle } from "@znerual/learnharness-vault-client";

import { hasVaultClient, loadIfVaultClient } from "./vault-helpers.ts";
import { startFakeKeystore, type FakeKeystore } from "./vault-fake-keystore-server.ts";

// The adapter encodes bundles with the private vault client; skipped without it (public CI).
const { decodeBundle, encodeBundle } = await loadIfVaultClient<typeof import("@znerual/learnharness-vault-client")>("@znerual/learnharness-vault-client");
const { AndroidKeyStorage } = await loadIfVaultClient<typeof import("../src/server/vault/keystorage-android.ts")>("../src/server/vault/keystorage-android.ts");

const dirs: string[] = [];
const servers: FakeKeystore[] = [];
after(async () => {
	for (const s of servers) await s.close();
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const bundle: SecretBundle = {
	accountId: "acc", serverUrl: "https://vault.example.test", deviceId: "dev", deviceToken: "tok",
	deviceSeed: new Uint8Array(32).fill(7), deviceMethodId: "m1", generation: 3,
	rootKey: new Uint8Array(32).fill(1), ik: new Uint8Array(32).fill(2), vaultKeys: [new Uint8Array(32).fill(3)],
	highWater: { generation: 3, epoch: 1 },
	pins: {},
	consumedMethods: [],
};

async function setup(init: Parameters<typeof startFakeKeystore>[0] = {}, secret?: string) {
	const fake = await startFakeKeystore(init);
	servers.push(fake);
	const dir = await mkdtemp(join(tmpdir(), "lhv-aks-"));
	dirs.push(dir);
	const file = join(dir, "local", "vault-secrets.enc");
	const ks = new AndroidKeyStorage({ url: fake.url, secret: secret ?? fake.secret, file, timeoutMs: 2000 });
	return { fake, file, ks };
}

describe("AndroidKeyStorage against the KeystoreServer contract", { skip: !hasVaultClient && "the vault client package is not installed" }, () => {
	it("round-trips, stores 0x01||iv||ct||tag at mode 0600, and clear deletes file and key", async () => {
		const { fake, file, ks } = await setup();
		assert.deepEqual(await ks.status(), { available: true, protection: "keystore-tee", backend: "tee" });
		assert.equal(await ks.load(), null);
		await ks.save(bundle);
		const blob = await readFile(file);
		assert.equal(blob[0], 1);
		assert.equal(blob.length, 1 + 12 + Buffer.byteLength(encodeBundle(bundle)) + 16);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.ok(!blob.toString("latin1").includes("rootKey"));
		assert.deepEqual(await ks.load(), bundle);
		await ks.save({ ...bundle, generation: 9 });
		assert.equal((await ks.load())?.generation, 9);
		assert.deepEqual(await readdir(join(file, "..")), ["vault-secrets.enc"]);
		await ks.clear();
		await ks.clear();
		assert.equal(await ks.load(), null);
		assert.equal(fake.key, null);
	});

	it("reports StrongBox", async () => {
		const { ks } = await setup({ level: "strongbox" });
		assert.deepEqual(await ks.status(), { available: true, protection: "keystore-strongbox", backend: "strongbox" });
	});

	it("software-only key is unavailable in release and refuses save", async () => {
		const { ks, file } = await setup({ level: "software", debug: false });
		assert.deepEqual(await ks.status(), { available: false, reason: "software_only", backend: "software" });
		await assert.rejects(ks.save(bundle), { code: "no_secure_storage" });
		await assert.rejects(readFile(file), /ENOENT/);
	});

	it("software-only key works in a debug build", async () => {
		const { ks } = await setup({ level: "software", debug: true });
		assert.deepEqual(await ks.status(), { available: true, protection: "keystore-tee", backend: "software-debug" });
		await ks.save(bundle);
		assert.deepEqual(await ks.load(), bundle);
	});

	it("wrong secret: 401 makes status bridge_missing and load/save io", async () => {
		const { ks } = await setup({}, "not-the-secret");
		assert.deepEqual(await ks.status(), { available: false, reason: "bridge_missing" });
		await assert.rejects(ks.save(bundle), { code: "io", message: /rejected the secret/ });
	});

	it("flipped byte in the blob -> corrupt (GCM tag)", async () => {
		const { ks, file } = await setup();
		await ks.save(bundle);
		const blob = await readFile(file);
		blob[20] = (blob[20] ?? 0) ^ 0xff;
		await writeFile(file, blob);
		await assert.rejects(ks.load(), { code: "corrupt" });
	});

	it("wrapping key gone (data cleared, key invalidated) -> corrupt", async () => {
		const { fake, ks } = await setup();
		await ks.save(bundle);
		fake.key = null;
		await assert.rejects(ks.load(), { code: "corrupt" });
	});

	it("truncated or wrongly versioned file -> corrupt without calling the keystore", async () => {
		const { fake, ks, file } = await setup();
		await ks.save(bundle);
		fake.calls.length = 0;
		await writeFile(file, Buffer.from([1, 2, 3]));
		await assert.rejects(ks.load(), { code: "corrupt" });
		await writeFile(file, Buffer.concat([Buffer.from([2]), Buffer.alloc(60)]));
		await assert.rejects(ks.load(), { code: "corrupt" });
		assert.deepEqual(fake.calls, []);
	});

	it("blob that is not wrapped data of this app (decrypts to non-bundle JSON) -> corrupt", async () => {
		const { fake } = await setup();
		// A wrapped payload that is valid GCM but not a bundle:
		const r = await fetch(`${fake.url}/keystore/wrap`, { method: "POST", headers: { authorization: `Bearer ${fake.secret}` }, body: Buffer.from("{}").toString("base64") });
		const blob = Buffer.from(await r.text(), "base64");
		const dir = await mkdtemp(join(tmpdir(), "lhv-aks-"));
		dirs.push(dir);
		await writeFile(join(dir, "s.enc"), blob);
		const ks2 = new AndroidKeyStorage({ url: fake.url, secret: fake.secret, file: join(dir, "s.enc") });
		await assert.rejects(ks2.load(), { code: "corrupt" });
	});

	it("unreachable server: status bridge_missing, load io, clear still removes the file", async () => {
		const { fake, ks, file } = await setup();
		await ks.save(bundle);
		await fake.close();
		assert.deepEqual(await ks.status(), { available: false, reason: "bridge_missing" });
		await assert.rejects(ks.load(), { code: "io" });
		await ks.clear();
		await assert.rejects(readFile(file), /ENOENT/);
	});

	it("no bridge configured: bridge_missing, no_secure_storage, clear is a no-op", async () => {
		const ks = AndroidKeyStorage.fromEnv({}, "/nonexistent");
		assert.deepEqual(await ks.status(), { available: false, reason: "bridge_missing" });
		await assert.rejects(ks.save(bundle), { code: "no_secure_storage" });
		await ks.clear();
		assert.equal(await ks.load(), null);
	});

	it("fromEnv reads LH_KEYSTORE_URL, the secret and LH_LOCAL_DIR", async () => {
		const fake = await startFakeKeystore();
		servers.push(fake);
		const dir = await mkdtemp(join(tmpdir(), "lhv-aks-"));
		dirs.push(dir);
		const ks = AndroidKeyStorage.fromEnv({ LH_KEYSTORE_URL: fake.url, LH_DESKTOP_API_SECRET: fake.secret, LH_LOCAL_DIR: dir });
		await ks.save(bundle);
		assert.ok((await stat(join(dir, "vault-secrets.enc"))).isFile());
		// The first sync start empties <local>/vault/ (runtime.ts bootstrap); the sign-in must survive it.
		await mkdir(join(dir, "vault"), { recursive: true });
		await rm(join(dir, "vault"), { recursive: true, force: true });
		assert.deepEqual(await ks.load(), bundle);
		assert.deepEqual(decodeBundle(encodeBundle(bundle)), bundle);
	});
});
