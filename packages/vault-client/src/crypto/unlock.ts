// Unlock-method key pairs, sealed root keys, key commitments and public key tags
// (ADR 0002 Key acceptance, ADR 0003).

import { type Bytes, bytesEqual, concat, readU32be, u32be } from "./bytes.ts";
import { FOREIGN_KEY_MESSAGE, ProtocolError } from "./errors.ts";
import { checkAccountId, checkCounter, checkMethodKind, type MethodKind } from "./framing.ts";
import { KEY_BYTES } from "./keys.ts";
import { sodium } from "./sodium.ts";

export const SEALED_ROOT_BYTES = 32 + 4 + KEY_BYTES + 16; // ephemeral pk, u32 g, ARK, MAC

export interface BoxKeyPair {
	readonly publicKey: Bytes;
	readonly secretKey: Bytes;
}

export function hash(length: number, message: Bytes | string, key?: Bytes): Bytes {
	return sodium.crypto_generichash(length, message, key ?? null);
}

/** X25519 key pair from a 32-byte seed, as crypto_box_seed_keypair. */
export function boxKeyPairFromSeed(seed: Bytes): BoxKeyPair {
	if (seed.length !== 32) throw new ProtocolError("bad_format", "seed must be 32 bytes");
	const kp = sodium.crypto_box_seed_keypair(seed);
	return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function passwordSeed(exportKey: Bytes): Bytes {
	return hash(32, "lhv1/unlock/password", exportKey);
}

/** PRF salt the client passes to WebAuthn for the passkey unlock method. */
export const PASSKEY_PRF_SALT = "lhv1/unlock/passkey";

export function passkeySeed(prfOutput: Bytes): Bytes {
	return hash(32, "lhv1/unlock/passkey", prfOutput);
}

/** sealed = crypto_box_seal(u32 g || ARK_g, pk). */
export function sealRootKey(generation: number, ark: Bytes, publicKey: Bytes): Bytes {
	if (ark.length !== KEY_BYTES || publicKey.length !== 32) throw new ProtocolError("bad_format", "bad key length");
	return sodium.crypto_box_seal(concat(u32be(checkCounter(generation, "generation")), ark), publicKey);
}

/**
 * crypto_box_seal with a caller-chosen ephemeral seed. Byte-identical to crypto_box_seal;
 * exists only so that test vectors are reproducible. Never use it for real seals.
 */
export function sealRootKeyDeterministic(generation: number, ark: Bytes, publicKey: Bytes, ephemeralSeed: Bytes): Bytes {
	const eph = boxKeyPairFromSeed(ephemeralSeed);
	const nonce = hash(24, concat(eph.publicKey, publicKey));
	const msg = concat(u32be(checkCounter(generation, "generation")), ark);
	return concat(eph.publicKey, sodium.crypto_box_easy(msg, nonce, publicKey, eph.secretKey));
}

export interface OpenedRootKey {
	readonly generation: number;
	readonly rootKey: Bytes;
}

export function openRootKey(sealed: Bytes, keyPair: BoxKeyPair): OpenedRootKey {
	if (sealed.length !== SEALED_ROOT_BYTES) throw new ProtocolError("bad_format", `sealed root key must be ${SEALED_ROOT_BYTES} bytes`);
	let plain: Bytes;
	try {
		plain = sodium.crypto_box_seal_open(sealed, keyPair.publicKey, keyPair.secretKey);
	} catch {
		throw new ProtocolError("decrypt_failed", "cannot open the sealed root key with this unlock method");
	}
	const generation = checkCounter(readU32be(plain), "generation");
	const rootKey = plain.slice(4);
	sodium.memzero(plain);
	return { generation, rootKey };
}

export function ikTag(ik: Bytes): Bytes {
	return hash(32, "lhv1/ik-tag", ik);
}

export function commitKey(seed: Bytes): Bytes {
	return hash(32, "lhv1/commit-key", seed);
}

/** commit = H32(key = commitKey(seed), "lhv1/commit/" || accountId || "/" || kind || "/" || pk || ikTag(IK)). */
export function commitment(seed: Bytes, accountId: string, kind: MethodKind, publicKey: Bytes, ik: Bytes): Bytes {
	if (publicKey.length !== 32) throw new ProtocolError("bad_format", "public key must be 32 bytes");
	const ck = commitKey(seed);
	const out = hash(32, concat("lhv1/commit/", checkAccountId(accountId), "/", checkMethodKind(kind), "/", publicKey, ikTag(ik)), ck);
	sodium.memzero(ck);
	return out;
}

/** Throws ProtocolError("foreign_key") unless `commit` matches (ADR 0002 rule 1, rule 6). */
export function verifyCommitment(commit: Bytes | null | undefined, seed: Bytes, accountId: string, kind: MethodKind, publicKey: Bytes, ik: Bytes): void {
	if (!commit) throw new ProtocolError("no_commitment", "This unlock method has no key commitment and cannot unlock");
	if (!bytesEqual(commit, commitment(seed, accountId, kind, publicKey, ik))) throw new ProtocolError("foreign_key", FOREIGN_KEY_MESSAGE);
}

export function pkTagKey(ik: Bytes): Bytes {
	return hash(32, "lhv1/pk-tag-key", ik);
}

/** pkTag = H32(key = pkTagKey(IK), "lhv1/method-pk/" || accountId || "/" || kind || "/" || pk). */
export function pkTag(ik: Bytes, accountId: string, kind: MethodKind, publicKey: Bytes): Bytes {
	if (publicKey.length !== 32) throw new ProtocolError("bad_format", "public key must be 32 bytes");
	const k = pkTagKey(ik);
	const out = hash(32, concat("lhv1/method-pk/", checkAccountId(accountId), "/", checkMethodKind(kind), "/", publicKey), k);
	sodium.memzero(k);
	return out;
}

/** Throws ProtocolError("pk_tag_mismatch") unless `tag` matches (ADR 0002 rule 5). */
export function verifyPkTag(tag: Bytes | null | undefined, ik: Bytes, accountId: string, kind: MethodKind, publicKey: Bytes): void {
	if (!tag || !bytesEqual(tag, pkTag(ik, accountId, kind, publicKey))) {
		throw new ProtocolError("pk_tag_mismatch", `The ${kind} unlock method's public key does not belong to this account`);
	}
}

/** Everything a new unlock method row needs, computed by a device that holds ARK and IK. */
export interface NewMethod {
	readonly kind: MethodKind;
	readonly publicKey: Bytes;
	readonly sealed: Bytes;
	readonly commit: Bytes;
	readonly pkTag: Bytes;
}

export function createMethod(kind: MethodKind, seed: Bytes, accountId: string, generation: number, ark: Bytes, ik: Bytes): NewMethod {
	const kp = boxKeyPairFromSeed(seed);
	sodium.memzero(kp.secretKey);
	return {
		kind,
		publicKey: kp.publicKey,
		sealed: sealRootKey(generation, ark, kp.publicKey),
		commit: commitment(seed, accountId, kind, kp.publicKey, ik),
		pkTag: pkTag(ik, accountId, kind, kp.publicKey),
	};
}
