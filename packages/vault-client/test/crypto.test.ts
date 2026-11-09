import assert from "node:assert/strict";
import { test } from "node:test";

import {
	acceptRotation, boxKeyPairFromSeed, buildRotation, createMethod, decodePairingText, decryptRecord, encodePairingText, encryptRecord,
	generateBackupCodes, generatePairingSecret, generateRecoveryKey, newAccountKeys, parseRecoverySecret, ProtocolError, randomBytes,
	recoveryMaterial, unlock, vaultKeyFor, wrapAllKeys,
} from "../src/crypto/index.ts";

const ACCOUNT = "11111111-2222-4333-8444-555555555555";

test("random recovery secrets round-trip through their display text", () => {
	const rk = generateRecoveryKey();
	assert.match(rk.display(), /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
	assert.deepEqual(parseRecoverySecret("recovery_key", rk.display()).secretBytes, rk.secretBytes);
	const codes = generateBackupCodes();
	assert.equal(codes.length, 10);
	for (const c of codes) {
		assert.match(c.display(), /^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
		assert.deepEqual(parseRecoverySecret("backup_code", c.display().toLowerCase()).secretBytes, c.secretBytes);
	}
	const s = generatePairingSecret();
	assert.deepEqual(decodePairingText(encodePairingText(s)), s);
});

test("a secret's JSON form does not leak its text", () => {
	const rk = generateRecoveryKey();
	assert.ok(!JSON.stringify(rk).includes(rk.display().slice(0, 4) + "-"));
});

test("signup keys, every method, rotation and record round trip", () => {
	const keys = newAccountKeys(ACCOUNT);
	const wraps = wrapAllKeys(keys);
	const salt = randomBytes(16);
	const rk = recoveryMaterial(generateRecoveryKey(), salt);
	const deviceSeed = randomBytes(32);
	const methods = [
		{ id: "m1", seed: rk.unlockSeed, ...createMethod("recovery_key", rk.unlockSeed, ACCOUNT, 1, keys.rootKey, keys.ik) },
		{ id: "m2", seed: deviceSeed, ...createMethod("device", deviceSeed, ACCOUNT, 1, keys.rootKey, keys.ik) },
	];
	for (const m of methods) {
		const k = unlock({ accountId: ACCOUNT, generation: 1, epoch: 1, wraps, method: m, seed: m.seed, keyPair: boxKeyPairFromSeed(m.seed) });
		assert.deepEqual(k.ik, keys.ik);
	}
	const rot = buildRotation(keys, methods.map((m) => ({ id: m.id, kind: m.kind, publicKey: m.publicKey, pkTag: m.pkTag })));
	assert.equal(rot.next.generation, 2);
	const accepted = acceptRotation(keys, 2, rot.next.rootKey, 2, rot.wraps);
	assert.equal(accepted.vaultKeys.length, 2);
	const sealed = encryptRecord(ACCOUNT, keys.ik, 2, vaultKeyFor(accepted, 2) as Uint8Array, {
		header: { kind: "doc", path: "chats/x.json", baseSeq: 0, deleted: false, deviceId: "dev_abcdefgh", writtenAt: new Date().toISOString() },
		body: new TextEncoder().encode("{}"),
	});
	const p = decryptRecord(ACCOUNT, keys.ik, sealed.recordId, "doc", sealed.envelope, (e) => vaultKeyFor(accepted, e));
	assert.equal(new TextDecoder().decode(p.body), "{}");
	// A rotation that would seal to a method whose pkTag was replaced is refused.
	const evil = boxKeyPairFromSeed(randomBytes(32)).publicKey;
	assert.throws(() => buildRotation(keys, [{ id: "m2", kind: "device", publicKey: evil, pkTag: methods[1]!.pkTag }]), (e: unknown) => e instanceof ProtocolError && e.code === "pk_tag_mismatch");
	// A pinned public key that changed is refused even with a valid tag.
	assert.throws(
		() => buildRotation(keys, [{ id: "m2", kind: "device", publicKey: methods[1]!.publicKey, pkTag: methods[1]!.pkTag }], new Map([["m2", evil]])),
		(e: unknown) => e instanceof ProtocolError && e.code === "pk_tag_mismatch",
	);
});
