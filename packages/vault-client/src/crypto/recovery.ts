// Recovery key and backup codes (ADR 0005), Crockford Base32 text encoding.

import { type Bytes, concat } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { checkAccountId } from "./framing.ts";
import { randomBytes } from "./keys.ts";
import { type BoxKeyPair, boxKeyPairFromSeed, hash } from "./unlock.ts";
import { sodium } from "./sodium.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const SECRET_FORMATS = {
	recovery_key: { chars: 32, bytes: 20, group: 4, bits: 160 },
	backup_code: { chars: 20, bytes: 13, group: 5, bits: 100 },
	pairing: { chars: 52, bytes: 32, group: 0, bits: 256 },
} as const;
export type SecretFormat = keyof typeof SECRET_FORMATS;
export type RecoveryKind = "recovery_key" | "backup_code";

export const ACCOUNT_SALT_BYTES = 16;
export const RECOVERY_DERIVATION_VERSION = 1;
export const BACKUP_CODE_COUNT = 10;

/** Encodes `bytes` (big-endian value) as `chars` Crockford characters, left-padded with zero bits. */
export function crockfordEncode(bytes: Bytes, chars: number, group = 0): string {
	let v = 0n;
	for (const b of bytes) v = (v << 8n) | BigInt(b);
	if (v >> BigInt(chars * 5) !== 0n) throw new ProtocolError("bad_code", "value does not fit");
	let s = "";
	for (let i = 0; i < chars; i++) {
		s = ALPHABET[Number(v & 31n)] + s;
		v >>= 5n;
	}
	if (group <= 0) return s;
	const groups: string[] = [];
	for (let i = 0; i < s.length; i += group) groups.push(s.slice(i, i + group));
	return groups.join("-");
}

/** Case-insensitive, dashes and whitespace optional, O→0, I/L→1. Rejects wrong length, bad characters and non-zero padding bits. */
export function crockfordDecode(text: string, chars: number, byteLength: number): Bytes {
	const t = text.replace(/[-\s]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
	if (t.length !== chars) throw new ProtocolError("bad_code", `expected ${chars} characters, got ${t.length}`);
	let v = 0n;
	for (const ch of t) {
		const i = ALPHABET.indexOf(ch);
		if (i < 0) throw new ProtocolError("bad_code", "invalid character");
		v = (v << 5n) | BigInt(i);
	}
	if (v >> BigInt(byteLength * 8) !== 0n) throw new ProtocolError("bad_code", "padding bits are not zero");
	const out = new Uint8Array(byteLength);
	for (let i = byteLength - 1; i >= 0; i--) {
		out[i] = Number(v & 255n);
		v >>= 8n;
	}
	return out;
}

function randomSecret(format: RecoveryKind): Bytes {
	const f = SECRET_FORMATS[format];
	const b = randomBytes(f.bytes);
	const spare = f.bytes * 8 - f.bits;
	b[0] = (b[0] as number) & (0xff >> spare);
	return b;
}

/** A secret held in memory only. `display()` is the only way to get its text. */
export interface RecoverySecret {
	readonly kind: RecoveryKind;
	readonly secretBytes: Bytes;
	display(): string;
}

function makeSecret(kind: RecoveryKind, secretBytes: Bytes): RecoverySecret {
	const f = SECRET_FORMATS[kind];
	return {
		kind,
		secretBytes,
		display: () => crockfordEncode(secretBytes, f.chars, f.group),
	};
}

export function generateRecoveryKey(): RecoverySecret {
	return makeSecret("recovery_key", randomSecret("recovery_key"));
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): RecoverySecret[] {
	return Array.from({ length: count }, () => makeSecret("backup_code", randomSecret("backup_code")));
}

/** Parses typed text into a recovery secret. */
export function parseRecoverySecret(kind: RecoveryKind, text: string): RecoverySecret {
	const f = SECRET_FORMATS[kind];
	return makeSecret(kind, crockfordDecode(text, f.chars, f.bytes));
}

/** Tells a recovery key from a backup code by its length without dashes. */
export function guessRecoveryKind(text: string): RecoveryKind | null {
	const n = text.replace(/[-\s]/g, "").length;
	if (n === SECRET_FORMATS.recovery_key.chars) return "recovery_key";
	if (n === SECRET_FORMATS.backup_code.chars) return "backup_code";
	return null;
}

export interface RecoveryMaterial {
	readonly unlockSeed: Bytes;
	readonly unlock: BoxKeyPair;
	readonly authPublicKey: Bytes;
	readonly authSecretKey: Bytes;
}

/** material = H64(key = accountSalt, "lhv1/recovery/" || kind || "/" || secretBytes). */
export function recoveryMaterial(secret: RecoverySecret, accountSalt: Bytes): RecoveryMaterial {
	if (accountSalt.length !== ACCOUNT_SALT_BYTES) throw new ProtocolError("bad_format", "accountSalt must be 16 bytes");
	if (secret.secretBytes.length !== SECRET_FORMATS[secret.kind].bytes) throw new ProtocolError("bad_format", "bad secret length");
	const material = hash(64, concat("lhv1/recovery/", secret.kind, "/", secret.secretBytes), accountSalt);
	const unlockSeed = material.slice(0, 32);
	const auth = sodium.crypto_sign_seed_keypair(material.subarray(32, 64));
	sodium.memzero(material);
	return { unlockSeed, unlock: boxKeyPairFromSeed(unlockSeed), authPublicKey: auth.publicKey, authSecretKey: auth.privateKey };
}

export const RECOVERY_CHALLENGE_BYTES = 32;

export function recoveryChallengeMessage(accountId: string, challenge: Bytes): Bytes {
	if (challenge.length !== RECOVERY_CHALLENGE_BYTES) throw new ProtocolError("bad_format", "challenge must be 32 bytes");
	return concat("lhv1/recover/", checkAccountId(accountId), challenge);
}

/** Ed25519 signature over "lhv1/recover/" || accountId || challenge with the auth key. */
export function signRecoveryChallenge(material: RecoveryMaterial, accountId: string, challenge: Bytes): Bytes {
	return sodium.crypto_sign_detached(recoveryChallengeMessage(accountId, challenge), material.authSecretKey);
}
