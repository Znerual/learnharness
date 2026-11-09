// Loads test/vectors/*.json and checks the TypeScript implementation against them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	acceptRotation, approveTag, boxKeyPairFromSeed, checkAccountId, checkCounter, checkMethodKind, checkRecordKind, checkWrapName, commitKey,
	commitment, confirmationCode, decodePairingQr, decodePairingText, decryptRecord, encodeHeader, encodePairingQr, encodePairingText,
	encodePlaintext, encryptRecord, fromHex, fromUtf8, hash, ikTag, joinTag, type KeySet, lengthPrefixed, type MethodKind, openRootKey,
	parseCanonicalDecimal, parseRecoverySecret, passkeySeed, passwordSeed, pkTag, ProtocolError, type RecordHeader, type RecordKind, recordId,
	recoveryMaterial, sealRootKeyDeterministic, signRecoveryChallenge, toHex, unlock, unwrapKey, verifyApproveTag, verifyCommitment,
	verifyJoinTag, verifyPkTag, wrapAd, wrapKey, type RecoveryKind, type Wrap, sodium,
} from "../src/crypto/index.ts";

const DIR = join(import.meta.dirname, "vectors");
// biome-ignore lint: vectors are untyped JSON
const load = (name: string): any => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const h = fromHex;
const code = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		if (e instanceof ProtocolError) return e.code;
		throw e;
	}
	return "ok";
};

describe("framing", () => {
	const v = load("framing.json");
	test("accountId", () => {
		for (const s of v.accountId.valid) assert.equal(checkAccountId(s), s);
		for (const s of v.accountId.invalid) assert.equal(code(() => checkAccountId(s)), "bad_format", s);
	});
	test("counter", () => {
		for (const s of v.counter.valid) checkCounter(parseCanonicalDecimal(s, "n"), "n");
		for (const s of v.counter.invalid) assert.equal(code(() => checkCounter(parseCanonicalDecimal(s, "n"), "n")), "bad_format", s);
	});
	test("labels", () => {
		for (const s of v.wrapName.valid) checkWrapName(s);
		for (const s of v.wrapName.invalid) assert.equal(code(() => checkWrapName(s)), "bad_format", s);
		for (const s of v.methodKind.valid) checkMethodKind(s);
		for (const s of v.methodKind.invalid) assert.equal(code(() => checkMethodKind(s)), "bad_format", s);
		for (const s of v.recordKind.valid) checkRecordKind(s);
		for (const s of v.recordKind.invalid) assert.equal(code(() => checkRecordKind(s)), "bad_format", s);
	});
	test("length prefix", () => {
		for (const c of v.lengthPrefixed) assert.equal(toHex(lengthPrefixed(c.field)), c.encoded);
	});
});

describe("wrap", () => {
	const v = load("wrap.json");
	test("valid wraps are byte-identical and unwrap", () => {
		for (const c of v.valid) {
			assert.equal(toHex(wrapAd(c.accountId, c.name, c.generation)), c.ad);
			assert.equal(toHex(wrapKey(h(c.rootKey), c.generation, c.accountId, c.name, h(c.key), h(c.nonce))), c.wrap);
			assert.equal(toHex(unwrapKey(h(c.rootKey), c.generation, c.accountId, c.name, h(c.wrap))), c.key);
		}
	});
	test("invalid wraps are rejected", () => {
		for (const c of v.invalid) {
			assert.notEqual(code(() => unwrapKey(h(c.rootKey), c.generation, c.accountId, c.name, h(c.wrap))), "ok", c.why);
		}
	});
});

describe("unlock", () => {
	const v = load("unlock.json");
	const ik = h(v.ik);
	test("seeds", () => {
		assert.equal(toHex(passwordSeed(h(v.seedInputs.opaqueExportKey))), v.seedInputs.passwordSeed);
		assert.equal(toHex(passkeySeed(h(v.seedInputs.prfOutput))), v.seedInputs.passkeySeed);
		assert.equal(toHex(ikTag(ik)), v.ikTag);
		assert.equal(toHex(hash(32, "lhv1/pk-tag-key", ik)), v.pkTagKey);
	});
	test("methods: key pairs, commitments, pkTags, deterministic seals, unlock", () => {
		const wraps: Wrap[] = v.wraps.map((w: { name: string; wrap: string }) => ({ name: w.name, wrap: h(w.wrap) }));
		for (const m of v.methods) {
			const kind = m.kind as MethodKind;
			const kp = boxKeyPairFromSeed(h(m.seed));
			assert.equal(toHex(kp.publicKey), m.publicKey, kind);
			assert.equal(toHex(kp.secretKey), m.secretKey, kind);
			assert.equal(toHex(commitKey(h(m.seed))), m.commitKey);
			assert.equal(toHex(commitment(h(m.seed), v.accountId, kind, kp.publicKey, ik)), m.commit);
			assert.equal(toHex(pkTag(ik, v.accountId, kind, kp.publicKey)), m.pkTag);
			assert.equal(toHex(sealRootKeyDeterministic(1, h(v.rootKey), kp.publicKey, h(m.ephemeralSeed))), m.sealed);
			const opened = openRootKey(h(m.sealed), kp);
			assert.equal(opened.generation, 1);
			assert.equal(toHex(opened.rootKey), v.rootKey);
			const keys = unlock({
				accountId: v.accountId, generation: 1, epoch: 1, wraps, seed: h(m.seed), keyPair: kp,
				method: { kind, publicKey: kp.publicKey, sealed: h(m.sealed), commit: h(m.commit) },
			});
			assert.equal(toHex(keys.ik), v.ik);
			assert.equal(toHex(keys.vaultKeys[0] as Uint8Array), v.vk1);
		}
	});
	test("invalid commitments, pkTags and seals are rejected", () => {
		for (const c of v.invalid.commit) assert.equal(code(() => verifyCommitment(h(c.commit), h(c.seed), v.accountId, c.kind, h(c.publicKey), ik)), "foreign_key", c.why);
		for (const c of v.invalid.pkTag) assert.equal(code(() => verifyPkTag(h(c.pkTag), ik, v.accountId, c.kind, h(c.publicKey))), "pk_tag_mismatch", c.why);
		for (const c of v.invalid.sealed) assert.notEqual(code(() => openRootKey(h(c.sealed), { publicKey: h(c.publicKey), secretKey: h(c.secretKey) })), "ok", c.why);
	});
	test("a method without a commitment cannot unlock", () => {
		const m = v.methods[0];
		const kp = boxKeyPairFromSeed(h(m.seed));
		const wraps: Wrap[] = v.wraps.map((w: { name: string; wrap: string }) => ({ name: w.name, wrap: h(w.wrap) }));
		assert.equal(code(() => unlock({ accountId: v.accountId, generation: 1, epoch: 1, wraps, seed: h(m.seed), keyPair: kp, method: { kind: m.kind, publicKey: kp.publicKey, sealed: h(m.sealed), commit: null } })), "no_commitment");
	});
});

describe("record", () => {
	const v = load("record.json");
	const ik = h(v.ik);
	const vk = (e: number) => (v.vaultKeys[String(e)] ? h(v.vaultKeys[String(e)]) : undefined);
	test("record ids", () => {
		for (const c of v.recordIds) assert.equal(recordId(ik, c.path), c.recordId, c.path);
		for (const p of v.invalidPaths) assert.equal(code(() => recordId(ik, p)), "bad_format", p);
	});
	test("valid envelopes are byte-identical and decrypt", () => {
		for (const c of v.valid) {
			const header = JSON.parse(c.header) as RecordHeader;
			assert.equal(fromUtf8(encodeHeader(header)), c.header);
			assert.equal(toHex(encodePlaintext({ header, body: h(c.body) })), c.plaintext);
			const sealed = encryptRecord(v.accountId, ik, c.epoch, h(c.vaultKey), { header, body: h(c.body) }, h(c.nonce));
			assert.equal(sealed.recordId, c.recordId);
			assert.equal(toHex(sealed.envelope), c.envelope);
			const p = decryptRecord(v.accountId, ik, c.recordId, c.kind as RecordKind, h(c.envelope), vk);
			assert.equal(toHex(p.body), c.body);
			assert.deepEqual(p.header, header);
		}
	});
	test("invalid envelopes are rejected with the stated error", () => {
		for (const c of v.invalid) assert.equal(code(() => decryptRecord(c.accountId, ik, c.recordId, c.kind, h(c.envelope), vk)), c.error, c.why);
	});
});

describe("recovery", () => {
	const v = load("recovery.json");
	test("derivation and signatures", () => {
		for (const s of v.secrets) {
			const secret = parseRecoverySecret(s.kind as RecoveryKind, s.text);
			assert.equal(toHex(secret.secretBytes), s.secretBytes);
			assert.equal(secret.display(), s.text);
			const mat = recoveryMaterial(secret, h(v.accountSalt));
			assert.equal(toHex(mat.unlockSeed), s.material.slice(0, 64));
			assert.equal(toHex(mat.unlock.publicKey), s.unlockPublicKey);
			assert.equal(toHex(mat.authPublicKey), s.authPublicKey);
			assert.equal(toHex(signRecoveryChallenge(mat, v.accountId, h(v.challenge))), s.signature);
			assert.ok(sodium.crypto_sign_verify_detached(h(s.signature), h(s.challengeMessage), h(s.authPublicKey)));
		}
	});
	test("text variants and invalid text", () => {
		for (const c of v.textVariants) assert.equal(toHex(parseRecoverySecret(c.kind, c.input).secretBytes), c.secretBytes, c.input);
		for (const c of v.invalidText) assert.equal(code(() => parseRecoverySecret(c.kind, c.input)), "bad_code", c.why);
	});
});

describe("pairing", () => {
	const v = load("pairing.json");
	const secret = h(v.secret);
	const pk = h(v.devicePublicKey);
	test("QR and text", () => {
		assert.equal(encodePairingQr({ serverUrl: v.serverUrl, pairingId: v.pairingId, secret }), v.qr);
		const qr = decodePairingQr(v.qr);
		assert.equal(qr.serverUrl, v.serverUrl);
		assert.equal(qr.pairingId, v.pairingId);
		assert.equal(toHex(qr.secret), v.secret);
		assert.equal(encodePairingText(secret), v.text);
		assert.equal(toHex(decodePairingText(v.text)), v.secret);
		assert.equal(toHex(decodePairingText(v.text.toLowerCase())), v.secret);
		for (const c of v.invalid.text) assert.equal(code(() => decodePairingText(c.input)), "bad_code", c.why);
		for (const q of v.invalid.qr) assert.notEqual(code(() => decodePairingQr(q)), "ok", q);
	});
	test("tags and confirmation code", () => {
		assert.equal(toHex(joinTag(secret, v.pairingId, pk, v.deviceName, v.lhDeviceId, v.ephemeral)), v.joinTag);
		assert.equal(toHex(approveTag(secret, v.pairingId, pk, h(v.sealed))), v.approveTag);
		assert.equal(confirmationCode(pk), v.confirmationCode);
		for (const c of v.extraCodes) assert.equal(confirmationCode(h(c.publicKey)), c.code);
		for (const c of v.invalid.joinTag) assert.equal(code(() => verifyJoinTag(h(c.tag), secret, c.pairingId, h(c.publicKey), c.name, c.lhDeviceId, c.ephemeral)), "pairing_tag", c.why);
		for (const c of v.invalid.approveTag) assert.equal(code(() => verifyApproveTag(h(c.tag), secret, c.pairingId, h(c.publicKey), h(c.sealed))), "pairing_tag", c.why);
	});
});

describe("rotation", () => {
	const v = load("rotation.json");
	const held: KeySet = { accountId: v.accountId, generation: v.held.generation, rootKey: h(v.held.rootKey), ik: h(v.held.ik), vaultKeys: v.held.vaultKeys.map(h) };
	const wraps = (ws: { name: string; wrap: string }[]): Wrap[] => ws.map((w) => ({ name: w.name, wrap: h(w.wrap) }));
	test("valid rotations are accepted", () => {
		for (const c of v.valid) {
			const next = acceptRotation(held, c.generation, h(c.rootKey), c.epoch, wraps(c.wraps));
			assert.equal(next.generation, c.generation);
			assert.equal(next.vaultKeys.length, c.epoch);
		}
	});
	test("invalid rotations are rejected", () => {
		for (const c of v.invalid) assert.equal(code(() => acceptRotation(held, c.generation, h(c.rootKey), c.epoch, wraps(c.wraps))), c.error, c.why);
	});
	test("rollback below the high-water mark is rejected", () => {
		const u = load("unlock.json");
		const m = u.methods[0];
		const kp = boxKeyPairFromSeed(h(m.seed));
		const ws = wraps(u.wraps);
		assert.equal(code(() => unlock({ accountId: u.accountId, generation: 1, epoch: 1, wraps: ws, seed: h(m.seed), keyPair: kp, method: { kind: m.kind, publicKey: kp.publicKey, sealed: h(m.sealed), commit: h(m.commit) }, highWater: v.rollback.highWater })), v.rollback.error);
	});
});
