// Generates test/vectors/*.json from fixed keys and nonces.
// Run: npm run vectors. Output is deterministic; CI checks that it is up to date.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	approveTag, boxKeyPairFromSeed, commitKey, commitment, concat, confirmationCode, crockfordEncode, encodeHeader, encodePairingQr,
	encodePairingText, encodePlaintext, encryptRecord, fromUtf8, hash, ikTag, joinTag, type KeySet, METHOD_KINDS, type MethodKind,
	parseRecoverySecret, passkeySeed, passwordSeed, pkTag, recordId, recoveryChallengeMessage, recoveryMaterial, type RecordHeader,
	sealRootKeyDeterministic, signRecoveryChallenge, sodium, toHex, u32be, vkName, wrapAd, wrapKey, type Wrap, SECRET_FORMATS,
} from "../src/crypto/index.ts";

const OUT = join(import.meta.dirname, "..", "test", "vectors");
const det = (label: string, n = 32): Uint8Array => hash(n, `lhv1-test/${label}`);
const hx = toHex;

const ACCOUNT = "4f9d2c1e-8b7a-4c3d-9e2f-1a2b3c4d5e6f";
const OTHER_ACCOUNT = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const IK = det("ik");
const ARK1 = det("ark/1");
const ARK2 = det("ark/2");
const VK1 = det("vk/1");
const VK2 = det("vk/2");

function write(name: string, body: object): void {
	writeFileSync(join(OUT, name), `${JSON.stringify(body, null, "\t")}\n`);
}

function flip(b: Uint8Array, i: number): Uint8Array {
	const c = b.slice();
	c[i] = (c[i] as number) ^ 0x01;
	return c;
}

// ---------- framing ----------
write("framing.json", {
	description: "Field formats (ADR 0002, Framing). Receivers reject every invalid value.",
	accountId: {
		valid: [ACCOUNT, OTHER_ACCOUNT],
		invalid: [ACCOUNT.toUpperCase(), ACCOUNT.replace(/-/g, ""), `{${ACCOUNT}}`, `${ACCOUNT} `, ""],
	},
	counter: { valid: ["1", "2", "10", "4294967295"], invalid: ["0", "01", "+1", "-1", "1.0", "4294967296", " 1", ""] },
	wrapName: { valid: ["ik", "vk/1", "vk/12"], invalid: ["vk/0", "vk/01", "vk/", "IK", "vk1", "vk/1/2"] },
	methodKind: { valid: [...METHOD_KINDS], invalid: ["Password", "recovery-key", "", "device/1"] },
	recordKind: { valid: ["doc", "seg"], invalid: ["DOC", "document", ""] },
	lengthPrefixed: [
		{ field: "dev", encoded: hx(concat(u32be(3), "dev")) },
		{ field: "Küche", encoded: hx(concat(u32be(6), "Küche")) },
	],
});

// ---------- wraps ----------
const wrapCases = [
	{ name: "ik", g: 1, ark: ARK1, key: IK, nonce: det("nonce/wrap/ik", 24) },
	{ name: "vk/1", g: 1, ark: ARK1, key: VK1, nonce: det("nonce/wrap/vk1", 24) },
	{ name: "vk/2", g: 2, ark: ARK2, key: VK2, nonce: det("nonce/wrap/vk2", 24) },
];
const wrapValid = wrapCases.map((c) => ({
	accountId: ACCOUNT, name: c.name, generation: c.g, rootKey: hx(c.ark), key: hx(c.key), nonce: hx(c.nonce),
	ad: hx(wrapAd(ACCOUNT, c.name, c.g)), wrap: hx(wrapKey(c.ark, c.g, ACCOUNT, c.name, c.key, c.nonce)),
}));
const ikWrap = wrapKey(ARK1, 1, ACCOUNT, "ik", IK, det("nonce/wrap/ik", 24));
write("wrap.json", {
	description: "wrap = nonce(24) || XChaCha20-Poly1305(key = ARK_g, nonce, message = key, ad = \"lhv1/wrap/\" || accountId || \"/\" || name || \"/\" || g).",
	valid: wrapValid,
	invalid: [
		{ why: "wrong name in associated data", accountId: ACCOUNT, name: "vk/1", generation: 1, rootKey: hx(ARK1), wrap: hx(ikWrap) },
		{ why: "wrong generation in associated data", accountId: ACCOUNT, name: "ik", generation: 2, rootKey: hx(ARK1), wrap: hx(ikWrap) },
		{ why: "wrong account in associated data", accountId: OTHER_ACCOUNT, name: "ik", generation: 1, rootKey: hx(ARK1), wrap: hx(ikWrap) },
		{ why: "wrong root key", accountId: ACCOUNT, name: "ik", generation: 1, rootKey: hx(ARK2), wrap: hx(ikWrap) },
		{ why: "truncated", accountId: ACCOUNT, name: "ik", generation: 1, rootKey: hx(ARK1), wrap: hx(ikWrap.subarray(0, ikWrap.length - 1)) },
		{ why: "flipped ciphertext bit", accountId: ACCOUNT, name: "ik", generation: 1, rootKey: hx(ARK1), wrap: hx(flip(ikWrap, 30)) },
	],
});

// ---------- unlock methods ----------
const exportKey = det("opaque-export-key", 64);
const prfOutput = det("prf-output");
const recoveryKeyBytes = (() => { const b = det("recovery-key-secret", 20); return b; })();
const backupCodeBytes = (() => { const b = det("backup-code-secret", 13); b[0] = (b[0] as number) & 0x0f; return b; })();
const accountSalt = det("account-salt", 16);
const recoveryKeyText = crockfordEncode(recoveryKeyBytes, 32, 4);
const backupCodeText = crockfordEncode(backupCodeBytes, 20, 5);
const rkMat = recoveryMaterial(parseRecoverySecret("recovery_key", recoveryKeyText), accountSalt);
const bcMat = recoveryMaterial(parseRecoverySecret("backup_code", backupCodeText), accountSalt);
const deviceSeed = det("device-seed");

const seeds: Record<MethodKind, Uint8Array> = {
	password: passwordSeed(exportKey),
	passkey: passkeySeed(prfOutput),
	recovery_key: rkMat.unlockSeed,
	backup_code: bcMat.unlockSeed,
	device: deviceSeed,
};
const methods = METHOD_KINDS.map((kind) => {
	const seed = seeds[kind];
	const kp = boxKeyPairFromSeed(seed);
	const sealed = sealRootKeyDeterministic(1, ARK1, kp.publicKey, det(`ephemeral/${kind}`));
	return {
		kind, seed: hx(seed), publicKey: hx(kp.publicKey), secretKey: hx(kp.secretKey), commitKey: hx(commitKey(seed)),
		commit: hx(commitment(seed, ACCOUNT, kind, kp.publicKey, IK)), pkTag: hx(pkTag(IK, ACCOUNT, kind, kp.publicKey)),
		ephemeralSeed: hx(det(`ephemeral/${kind}`)), sealed: hx(sealed),
	};
});
const pw = methods[0] as (typeof methods)[number];
const dev = methods[4] as (typeof methods)[number];
const pwKp = boxKeyPairFromSeed(seeds.password);
write("unlock.json", {
	description: "Unlock-method seeds, key pairs, sealed root keys, key commitments and public key tags (ADR 0002, ADR 0003). The account has generation 1, epoch 1.",
	accountId: ACCOUNT,
	ik: hx(IK),
	ikTag: hx(ikTag(IK)),
	pkTagKey: hx(hash(32, "lhv1/pk-tag-key", IK)),
	rootKey: hx(ARK1),
	generation: 1,
	vk1: hx(VK1),
	wraps: [{ name: "ik", wrap: hx(ikWrap) }, { name: "vk/1", wrap: hx(wrapKey(ARK1, 1, ACCOUNT, "vk/1", VK1, det("nonce/wrap/vk1", 24))) }],
	seedInputs: { opaqueExportKey: hx(exportKey), prfOutput: hx(prfOutput), passwordSeed: hx(seeds.password), passkeySeed: hx(seeds.passkey) },
	methods,
	invalid: {
		commit: [
			{ why: "commit of another kind", kind: "password", publicKey: pw.publicKey, seed: pw.seed, commit: hx(commitment(seeds.password, ACCOUNT, "device", pwKp.publicKey, IK)) },
			{ why: "commit of another account", kind: "password", publicKey: pw.publicKey, seed: pw.seed, commit: hx(commitment(seeds.password, OTHER_ACCOUNT, "password", pwKp.publicKey, IK)) },
			{ why: "commit over another index key", kind: "password", publicKey: pw.publicKey, seed: pw.seed, commit: hx(commitment(seeds.password, ACCOUNT, "password", pwKp.publicKey, det("other-ik"))) },
			{ why: "commit of another method in the account", kind: "password", publicKey: pw.publicKey, seed: pw.seed, commit: dev.commit },
		],
		pkTag: [
			{ why: "pkTag of another public key", kind: "password", publicKey: pw.publicKey, pkTag: dev.pkTag },
			{ why: "pkTag of another kind", kind: "password", publicKey: pw.publicKey, pkTag: hx(pkTag(IK, ACCOUNT, "device", pwKp.publicKey)) },
			{ why: "pkTag of another account", kind: "password", publicKey: pw.publicKey, pkTag: hx(pkTag(IK, OTHER_ACCOUNT, "password", pwKp.publicKey)) },
		],
		sealed: [
			{ why: "sealed to another method", kind: "password", secretKey: pw.secretKey, publicKey: pw.publicKey, sealed: dev.sealed },
			{ why: "truncated", kind: "password", secretKey: pw.secretKey, publicKey: pw.publicKey, sealed: pw.sealed.slice(0, -2) },
			{ why: "flipped bit", kind: "password", secretKey: pw.secretKey, publicKey: pw.publicKey, sealed: hx(flip(sodium.from_hex(pw.sealed), 40)) },
			{ why: "generation 0 inside", kind: "password", secretKey: pw.secretKey, publicKey: pw.publicKey, sealed: hx(sealZeroGeneration(pwKp.publicKey)) },
		],
	},
});

function sealZeroGeneration(pk: Uint8Array): Uint8Array {
	const eph = boxKeyPairFromSeed(det("ephemeral/zero"));
	const nonce = hash(24, concat(eph.publicKey, pk));
	return concat(eph.publicKey, sodium.crypto_box_easy(concat(u32be(0), ARK1), nonce, pk, eph.secretKey));
}

// ---------- records ----------
const docHeader: RecordHeader = { kind: "doc", path: "chats/chat_mvniw6ja_263d49a8.json", baseSeq: 41, deleted: false, deviceId: "dev_ab12cd34", writtenAt: "2026-11-01T10:15:30.123Z" };
const tombHeader: RecordHeader = { kind: "doc", path: "jobs/job_x1.json", baseSeq: 7, deleted: true, deviceId: "dev_ab12cd34", writtenAt: "2026-11-01T10:16:00Z" };
const segHeader: RecordHeader = { kind: "seg", path: "ledger/nodes/dev_ab12cd34/000000004096", ledger: "nodes", deviceId: "dev_ab12cd34", offset: 4096, writtenAt: "2026-11-01T10:17:00Z" };
const docBody = sodium.from_string('{"id":"chat_mvniw6ja_263d49a8","title":"Grüße"}\n');
const segBody = sodium.from_string('{"op":"add","id":"n1"}\n{"op":"add","id":"n2"}\n');
const keys1: KeySet = { accountId: ACCOUNT, generation: 1, rootKey: ARK1, ik: IK, vaultKeys: [VK1] };
const recordCases = [
	{ header: docHeader, body: docBody, epoch: 1, vk: VK1, nonce: det("nonce/rec/doc", 24) },
	{ header: tombHeader, body: new Uint8Array(0), epoch: 1, vk: VK1, nonce: det("nonce/rec/tomb", 24) },
	{ header: segHeader, body: segBody, epoch: 2, vk: VK2, nonce: det("nonce/rec/seg", 24) },
];
const recValid = recordCases.map((c) => {
	const sealed = encryptRecord(ACCOUNT, IK, c.epoch, c.vk, { header: c.header, body: c.body }, c.nonce);
	return {
		path: c.header.path, recordId: sealed.recordId, kind: c.header.kind, epoch: c.epoch, vaultKey: hx(c.vk), nonce: hx(c.nonce),
		header: fromUtf8(encodeHeader(c.header)), body: hx(c.body), plaintext: hx(encodePlaintext({ header: c.header, body: c.body })),
		envelope: hx(sealed.envelope),
	};
});
const docEnv = sodium.from_hex((recValid[0] as (typeof recValid)[number]).envelope);
const docId = (recValid[0] as (typeof recValid)[number]).recordId;
// A record whose header path does not hash to the id it is stored under (server swapped ids, re-encrypted by a key holder).
const otherPathId = recordId(IK, "chats/other.json");
const mislabeled = (() => {
	const plain = encodePlaintext({ header: docHeader, body: docBody });
	const n = det("nonce/rec/mislabeled", 24);
	const ad = concat("lhv1/rec/", ACCOUNT, "/", otherPathId, "/doc");
	return concat(new Uint8Array([1]), u32be(1), n, sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, ad, null, n, VK1));
})();
const wrongKind = (() => {
	const plain = encodePlaintext({ header: segHeader, body: segBody });
	const n = det("nonce/rec/wrongkind", 24);
	const id = recordId(IK, segHeader.path);
	const ad = concat("lhv1/rec/", ACCOUNT, "/", id, "/doc");
	return { id, env: concat(new Uint8Array([1]), u32be(1), n, sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, ad, null, n, VK1)) };
})();
const badVersion = docEnv.slice(); badVersion[0] = 2;
write("record.json", {
	description: "Record ids, record plaintext and envelopes (ADR 0002, Records). vaultKeys maps epoch to VK.",
	accountId: ACCOUNT,
	ik: hx(IK),
	vaultKeys: { "1": hx(VK1), "2": hx(VK2) },
	recordIds: ["chats/a.json", "graph/sources.json", "prompts/switches.json", "ledger/nodes/dev_ab12cd34/000000000000", "notes/Küche.md"].map((p) => ({ path: p, recordId: recordId(IK, p) })),
	invalidPaths: ["", "/abs.json", "a//b", "a/./b", "a/../b", "a\\b", "trailing/", "lhv1/pk-tag-key", "lhv1/anything"],
	valid: recValid,
	invalid: [
		{ why: "wrong account in associated data", accountId: OTHER_ACCOUNT, recordId: docId, kind: "doc", envelope: hx(docEnv), error: "decrypt_failed" },
		{ why: "wrong record id in associated data", accountId: ACCOUNT, recordId: otherPathId, kind: "doc", envelope: hx(docEnv), error: "decrypt_failed" },
		{ why: "wrong kind in associated data", accountId: ACCOUNT, recordId: docId, kind: "seg", envelope: hx(docEnv), error: "decrypt_failed" },
		{ why: "truncated envelope", accountId: ACCOUNT, recordId: docId, kind: "doc", envelope: hx(docEnv.subarray(0, 20)), error: "bad_format" },
		{ why: "truncated ciphertext", accountId: ACCOUNT, recordId: docId, kind: "doc", envelope: hx(docEnv.subarray(0, docEnv.length - 1)), error: "decrypt_failed" },
		{ why: "unknown envelope version", accountId: ACCOUNT, recordId: docId, kind: "doc", envelope: hx(badVersion), error: "bad_format" },
		{ why: "epoch the device does not hold", accountId: ACCOUNT, recordId: docId, kind: "doc", envelope: hx(concat(docEnv.subarray(0, 1), u32be(9), docEnv.subarray(5))), error: "decrypt_failed" },
		{ why: "header path does not match the record id", accountId: ACCOUNT, recordId: otherPathId, kind: "doc", envelope: hx(mislabeled), error: "wrong_record" },
		{ why: "header kind does not match", accountId: ACCOUNT, recordId: wrongKind.id, kind: "doc", envelope: hx(wrongKind.env), error: "wrong_record" },
	],
});

// ---------- recovery ----------
const challenge = det("recovery-challenge");
write("recovery.json", {
	description: "Recovery key and backup code encoding and the fast BLAKE2b derivation (ADR 0005). Ed25519 signatures are deterministic.",
	accountId: ACCOUNT,
	accountSalt: hx(accountSalt),
	challenge: hx(challenge),
	secrets: [
		{ kind: "recovery_key", text: recoveryKeyText, secretBytes: hx(recoveryKeyBytes), mat: rkMat },
		{ kind: "backup_code", text: backupCodeText, secretBytes: hx(backupCodeBytes), mat: bcMat },
	].map((s) => ({
		kind: s.kind, text: s.text, secretBytes: s.secretBytes,
		material: hx(hash(64, concat("lhv1/recovery/", s.kind, "/", sodium.from_hex(s.secretBytes)), accountSalt)),
		unlockPublicKey: hx(s.mat.unlock.publicKey), authPublicKey: hx(s.mat.authPublicKey),
		challengeMessage: hx(recoveryChallengeMessage(ACCOUNT, challenge)),
		signature: hx(signRecoveryChallenge(s.mat, ACCOUNT, challenge)),
	})),
	textVariants: [
		{ kind: "recovery_key", input: recoveryKeyText.toLowerCase(), secretBytes: hx(recoveryKeyBytes) },
		{ kind: "recovery_key", input: recoveryKeyText.replace(/-/g, ""), secretBytes: hx(recoveryKeyBytes) },
		{ kind: "backup_code", input: "0OIL1-00000-00000-0000Z", secretBytes: hx(parseRecoverySecret("backup_code", "00111-00000-00000-0000Z").secretBytes) },
	],
	invalidText: [
		{ kind: "recovery_key", input: recoveryKeyText.slice(0, -1), why: "one character short" },
		{ kind: "recovery_key", input: `${recoveryKeyText}0`, why: "one character long" },
		{ kind: "backup_code", input: "UUUUU-00000-00000-00000", why: "U is not in the alphabet" },
		{ kind: "backup_code", input: "*0000-00000-00000-00000", why: "invalid character" },
		{ kind: "recovery_key", input: backupCodeText, why: "backup code length" },
	],
	formats: SECRET_FORMATS,
});

// ---------- pairing ----------
const pairingSecret = det("pairing-secret");
const pairingId = sodium.to_base64(det("pairing-id", 16), sodium.base64_variants.URLSAFE_NO_PADDING);
const joinerKp = boxKeyPairFromSeed(det("joiner-device-seed"));
const deviceName = "Küchen-Laptop";
const joinerLhDeviceId = "dev_k1tch3n0";
const joinerEphemeral = false;
const pairSealed = sealRootKeyDeterministic(1, ARK1, joinerKp.publicKey, det("ephemeral/pairing"));
const jt = joinTag(pairingSecret, pairingId, joinerKp.publicKey, deviceName, joinerLhDeviceId, joinerEphemeral);
const at = approveTag(pairingSecret, pairingId, joinerKp.publicKey, pairSealed);
const text = encodePairingText(pairingSecret);
const highText = `G${text.slice(1)}`;
write("pairing.json", {
	description: "Pairing QR payload, 52-character text fallback, joinTag, approveTag and the 6-digit confirmation code (ADR 0003).",
	serverUrl: "https://vault.learnharness.example",
	pairingId,
	secret: hx(pairingSecret),
	qr: encodePairingQr({ serverUrl: "https://vault.learnharness.example", pairingId, secret: pairingSecret }),
	text,
	devicePublicKey: hx(joinerKp.publicKey),
	deviceName,
	lhDeviceId: joinerLhDeviceId,
	ephemeral: joinerEphemeral,
	joinTagInput: hx(concat("lhv1/pair/join", u32be(22), pairingId, joinerKp.publicKey, u32be(sodium.from_string(deviceName).length), deviceName, u32be(joinerLhDeviceId.length), joinerLhDeviceId, new Uint8Array([joinerEphemeral ? 1 : 0]))),
	joinTag: hx(jt),
	sealed: hx(pairSealed),
	approveTag: hx(at),
	confirmationCode: confirmationCode(joinerKp.publicKey),
	extraCodes: [0, 1, 2, 3].map((i) => { const pk = boxKeyPairFromSeed(det(`code-pk/${i}`)).publicKey; return { publicKey: hx(pk), code: confirmationCode(pk) }; }),
	invalid: {
		text: [
			{ input: highText, why: "first character above F sets a padding bit" },
			{ input: text.slice(1), why: "51 characters" },
		],
		joinTag: [
			{ why: "other device name", pairingId, publicKey: hx(joinerKp.publicKey), name: "Kuechen-Laptop", lhDeviceId: joinerLhDeviceId, ephemeral: joinerEphemeral, tag: hx(jt) },
			{ why: "other public key", pairingId, publicKey: hx(boxKeyPairFromSeed(det("attacker")).publicKey), name: deviceName, lhDeviceId: joinerLhDeviceId, ephemeral: joinerEphemeral, tag: hx(jt) },
			{ why: "other pairing id", pairingId: `${pairingId.slice(0, 21)}A`, publicKey: hx(joinerKp.publicKey), name: deviceName, lhDeviceId: joinerLhDeviceId, ephemeral: joinerEphemeral, tag: hx(jt) },
			{ why: "other LearnHarness device id", pairingId, publicKey: hx(joinerKp.publicKey), name: deviceName, lhDeviceId: "dev_0th3r000", ephemeral: joinerEphemeral, tag: hx(jt) },
			{ why: "other ephemeral flag", pairingId, publicKey: hx(joinerKp.publicKey), name: deviceName, lhDeviceId: joinerLhDeviceId, ephemeral: !joinerEphemeral, tag: hx(jt) },
			{ why: "tag made without the secret", pairingId, publicKey: hx(joinerKp.publicKey), name: deviceName, lhDeviceId: joinerLhDeviceId, ephemeral: joinerEphemeral, tag: hx(joinTag(det("wrong-secret"), pairingId, joinerKp.publicKey, deviceName, joinerLhDeviceId, joinerEphemeral)) },
		],
		approveTag: [
			{ why: "other sealed root key", pairingId, publicKey: hx(joinerKp.publicKey), sealed: hx(sealRootKeyDeterministic(1, ARK2, joinerKp.publicKey, det("ephemeral/pairing"))), tag: hx(at) },
			{ why: "other pairing id", pairingId: `${pairingId.slice(0, 21)}A`, publicKey: hx(joinerKp.publicKey), sealed: hx(pairSealed), tag: hx(at) },
			{ why: "tag made without the secret", pairingId, publicKey: hx(joinerKp.publicKey), sealed: hx(pairSealed), tag: hx(approveTag(det("wrong-secret"), pairingId, joinerKp.publicKey, pairSealed)) },
		],
		qr: ["lhv1-pair:https://vault.learnharness.example:short:" + sodium.to_base64(pairingSecret, sodium.base64_variants.URLSAFE_NO_PADDING), "lhv2-pair:x", `lhv1-pair:https://vault.learnharness.example:${pairingId}:AAAA`],
	},
});

// ---------- rotation acceptance ----------
const w = (ark: Uint8Array, g: number, name: string, key: Uint8Array): Wrap => ({ name, wrap: wrapKey(ark, g, ACCOUNT, name, key, det(`nonce/rot/${g}/${name}/${hx(key).slice(0, 8)}`, 24)) });
const wrapsHex = (ws: Wrap[]) => ws.map((x) => ({ name: x.name, wrap: hx(x.wrap) }));
const fakeVk1 = det("fake-vk1");
const ARK2b = det("ark/2b");
write("rotation.json", {
	description: "Rotation acceptance and no rollback (ADR 0002 rules 2 and 3). The device holds `held`; each case offers a generation, root key, epoch and wraps.",
	accountId: ACCOUNT,
	held: { generation: 1, rootKey: hx(keys1.rootKey), ik: hx(IK), vaultKeys: [hx(VK1)] },
	valid: [
		{ why: "honest rotation", generation: 2, rootKey: hx(ARK2), epoch: 2, wraps: wrapsHex([w(ARK2, 2, "ik", IK), w(ARK2, 2, "vk/1", VK1), w(ARK2, 2, "vk/2", VK2)]) },
		{ why: "two rotations seen at once", generation: 3, rootKey: hx(ARK2b), epoch: 3, wraps: wrapsHex([w(ARK2b, 3, "ik", IK), w(ARK2b, 3, "vk/1", VK1), w(ARK2b, 3, "vk/2", VK2), w(ARK2b, 3, "vk/3", det("vk/3"))]) },
	],
	invalid: [
		{ why: "vk/1 changed", error: "rotation_rejected", generation: 2, rootKey: hx(ARK2), epoch: 2, wraps: wrapsHex([w(ARK2, 2, "ik", IK), w(ARK2, 2, "vk/1", fakeVk1), w(ARK2, 2, "vk/2", VK2)]) },
		{ why: "index key changed", error: "rotation_rejected", generation: 2, rootKey: hx(ARK2), epoch: 2, wraps: wrapsHex([w(ARK2, 2, "ik", det("fake-ik")), w(ARK2, 2, "vk/1", VK1), w(ARK2, 2, "vk/2", VK2)]) },
		{ why: "no new vault key", error: "rotation_rejected", generation: 2, rootKey: hx(ARK2), epoch: 1, wraps: wrapsHex([w(ARK2, 2, "ik", IK), w(ARK2, 2, "vk/1", VK1)]) },
		{ why: "different root key with the same generation", error: "rotation_rejected", generation: 1, rootKey: hx(ARK2), epoch: 2, wraps: wrapsHex([w(ARK2, 1, "ik", IK), w(ARK2, 1, "vk/1", VK1), w(ARK2, 1, vkName(2), VK2)]) },
		{ why: "wraps under another generation", error: "rotation_rejected", generation: 2, rootKey: hx(ARK2), epoch: 2, wraps: wrapsHex([w(ARK2, 3, "ik", IK), w(ARK2, 3, "vk/1", VK1), w(ARK2, 3, "vk/2", VK2)]) },
		{ why: "missing vk/2 wrap", error: "rotation_rejected", generation: 2, rootKey: hx(ARK2), epoch: 2, wraps: wrapsHex([w(ARK2, 2, "ik", IK), w(ARK2, 2, "vk/1", VK1)]) },
	],
	rollback: { highWater: { generation: 2, epoch: 2 }, offered: { generation: 1, epoch: 1 }, error: "rollback" },
});

// ---------- export archive ----------
const rkKp = rkMat.unlock;
const bcKp = bcMat.unlock;
const exportRecords = recValid.filter((r) => r.kind === "doc");
const allWraps = [w(ARK2, 2, "ik", IK), w(ARK2, 2, "vk/1", VK1), w(ARK2, 2, "vk/2", VK2)];
const seg0Body = sodium.from_string('{"op":"add","id":"n0"}\n');
const segment = (offset: number, body: Uint8Array) =>
	encryptRecord(ACCOUNT, IK, 2, VK2, { header: { kind: "seg", path: `ledger/nodes/dev_ab12cd34/${String(offset).padStart(12, "0")}`, ledger: "nodes", deviceId: "dev_ab12cd34", offset, writtenAt: "2026-11-01T10:00:00Z" }, body }, det(`nonce/rec/seg/${offset}`, 24));
const segs = [segment(0, seg0Body), segment(seg0Body.length, segBody)];
const blobs = [...exportRecords.map((r) => ({ recordId: r.recordId, kind: r.kind, epoch: r.epoch, env: sodium.from_hex(r.envelope) })), ...segs.map((x) => ({ recordId: x.recordId, kind: "seg", epoch: 2, env: x.envelope }))];
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
const manifest = {
	format: "lhv-export",
	version: 1,
	accountId: ACCOUNT,
	createdAt: "2026-11-01T12:00:00Z",
	serverUrl: "https://vault.learnharness.example",
	accountSalt: b64(accountSalt),
	recoveryDerivation: 1,
	generation: 2,
	epoch: 2,
	methods: [
		{ kind: "recovery_key", publicKey: b64(rkKp.publicKey), sealed: b64(sealRootKeyDeterministic(2, ARK2, rkKp.publicKey, det("ephemeral/export/rk"))), commit: b64(commitment(rkMat.unlockSeed, ACCOUNT, "recovery_key", rkKp.publicKey, IK)) },
		{ kind: "backup_code", publicKey: b64(bcKp.publicKey), sealed: b64(sealRootKeyDeterministic(2, ARK2, bcKp.publicKey, det("ephemeral/export/bc"))), commit: b64(commitment(bcMat.unlockSeed, ACCOUNT, "backup_code", bcKp.publicKey, IK)) },
	],
	wraps: allWraps.map((x) => ({ name: x.name, wrap: b64(x.wrap) })),
	records: blobs.map((b, i) => ({ recordId: b.recordId, kind: b.kind, seq: 100 + i, epoch: b.epoch, blob: `blobs/${sha(b.env)}` })),
};
write("export.json", {
	description: "Export archive contents (ADR 0010). The tar holds manifest.json and blobs/<sha256>. Decrypting with recoveryKey or backupCode must produce `files`.",
	recoveryKey: recoveryKeyText,
	backupCode: backupCodeText,
	manifest,
	blobs: Object.fromEntries(blobs.map((b) => [`blobs/${sha(b.env)}`, hx(b.env)])),
	files: {
		"chats/chat_mvniw6ja_263d49a8.json": hx(docBody),
		"graph/nodes.dev_ab12cd34.jsonl": hx(concat(seg0Body, segBody)),
	},
	deleted: ["jobs/job_x1.json"],
	notes: "Segments ledger/<ledger>/<deviceId>/<offset> rebuild graph/<ledger>.<deviceId>.jsonl and ledger/<ledger>/base/<offset> rebuild graph/<ledger>.jsonl, concatenated in offset order. A gap or overlap stops that ledger at the gap and is reported. Tombstoned documents are not written.",
});
console.log(`vectors written to ${OUT}`);
