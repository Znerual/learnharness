// Account root key, vault keys, index key and their wraps (ADR 0002, Keys).

import { type Bytes, concat } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { checkAccountId, checkCounter, checkWrapName } from "./framing.ts";
import { sodium } from "./sodium.ts";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
const TAG_BYTES = 16;
export const WRAP_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;

export function randomBytes(n: number): Bytes {
	return sodium.randombytes_buf(n);
}

/** A fresh 32-byte key for ARK, VK or IK. */
export function generateKey(): Bytes {
	return randomBytes(KEY_BYTES);
}

/** Overwrites a secret buffer with zeros. */
export function wipe(...buffers: ReadonlyArray<Bytes | undefined | null>): void {
	for (const b of buffers) if (b) sodium.memzero(b);
}

export function wrapAd(accountId: string, name: string, generation: number): Bytes {
	return concat("lhv1/wrap/", checkAccountId(accountId), "/", checkWrapName(name), "/", String(checkCounter(generation, "generation")));
}

/** wrap = nonce(24) || XChaCha20-Poly1305(ARK_g, nonce, key, ad). `nonce` is for test vectors only. */
export function wrapKey(ark: Bytes, generation: number, accountId: string, name: string, key: Bytes, nonce?: Bytes): Bytes {
	if (ark.length !== KEY_BYTES || key.length !== KEY_BYTES) throw new ProtocolError("bad_format", "keys must be 32 bytes");
	const n = nonce ?? randomBytes(NONCE_BYTES);
	if (n.length !== NONCE_BYTES) throw new ProtocolError("bad_format", "nonce must be 24 bytes");
	const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(key, wrapAd(accountId, name, generation), null, n, ark);
	return concat(n, ct);
}

export function unwrapKey(ark: Bytes, generation: number, accountId: string, name: string, wrap: Bytes): Bytes {
	if (wrap.length !== WRAP_BYTES) throw new ProtocolError("bad_format", `wrap must be ${WRAP_BYTES} bytes`);
	const ad = wrapAd(accountId, name, generation);
	try {
		return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrap.subarray(NONCE_BYTES), ad, wrap.subarray(0, NONCE_BYTES), ark);
	} catch {
		throw new ProtocolError("decrypt_failed", `cannot unwrap ${name} under generation ${generation}`);
	}
}
