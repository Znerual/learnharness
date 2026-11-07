// Pairing QR payload, text fallback, tags and confirmation code (ADR 0003, Pairing).

import { type Bytes, bytesEqual, concat, fromB64, lengthPrefixed, readU32be, toB64, utf8 } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { randomBytes } from "./keys.ts";
import { crockfordDecode, crockfordEncode, SECRET_FORMATS } from "./recovery.ts";
import { hash, SEALED_ROOT_BYTES } from "./unlock.ts";

export const PAIRING_SECRET_BYTES = 32;
const PAIRING_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const MAX_DEVICE_NAME_BYTES = 64;

export function generatePairingSecret(): Bytes {
	return randomBytes(PAIRING_SECRET_BYTES);
}

export function checkPairingId(pairingId: string): string {
	if (!PAIRING_ID_RE.test(pairingId)) throw new ProtocolError("bad_format", "pairingId must be 22 base64url characters");
	return pairingId;
}

export function checkDeviceName(name: string): string {
	const n = utf8(name).length;
	if (n === 0 || n > MAX_DEVICE_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new ProtocolError("bad_format", `device name must be 1 to ${MAX_DEVICE_NAME_BYTES} bytes without control characters`);
	}
	return name;
}

export interface PairingPayload {
	readonly serverUrl: string;
	readonly pairingId: string;
	readonly secret: Bytes;
}

/** lhv1-pair:<serverUrl>:<pairingId>:<base64url secret>. */
export function encodePairingQr(p: PairingPayload): string {
	if (p.secret.length !== PAIRING_SECRET_BYTES) throw new ProtocolError("bad_format", "pairing secret must be 32 bytes");
	checkServerUrl(p.serverUrl);
	return `lhv1-pair:${p.serverUrl}:${checkPairingId(p.pairingId)}:${toB64(p.secret)}`;
}

function checkServerUrl(url: string): void {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new ProtocolError("bad_format", "server URL is not a URL");
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") throw new ProtocolError("bad_format", "server URL must be http(s)");
}

/** Parses a QR payload. The server URL may contain colons, so the last two fields are split off from the right. */
export function decodePairingQr(text: string): PairingPayload {
	const prefix = "lhv1-pair:";
	if (!text.startsWith(prefix)) throw new ProtocolError("bad_code", "not a vault pairing code");
	const rest = text.slice(prefix.length);
	const b = rest.lastIndexOf(":");
	const a = rest.lastIndexOf(":", b - 1);
	if (a <= 0 || b <= a) throw new ProtocolError("bad_code", "malformed pairing code");
	const serverUrl = rest.slice(0, a);
	checkServerUrl(serverUrl);
	const pairingId = checkPairingId(rest.slice(a + 1, b));
	let secret: Bytes;
	try {
		secret = fromB64(rest.slice(b + 1));
	} catch {
		throw new ProtocolError("bad_code", "malformed pairing secret");
	}
	if (secret.length !== PAIRING_SECRET_BYTES) throw new ProtocolError("bad_code", "pairing secret must be 32 bytes");
	return { serverUrl, pairingId, secret };
}

/** 52 Crockford characters, the 256-bit secret left-padded with 4 zero bits. */
export function encodePairingText(secret: Bytes): string {
	return crockfordEncode(secret, SECRET_FORMATS.pairing.chars);
}

export function decodePairingText(text: string): Bytes {
	return crockfordDecode(text, SECRET_FORMATS.pairing.chars, SECRET_FORMATS.pairing.bytes);
}

const LH_DEVICE_ID_RE = /^dev_[0-9a-z]{8}$/;

/**
 * joinTag = H32(key = secret, "lhv1/pair/join" || len(pairingId) || pairingId || pk || len(name) || name
 * || len(lhDeviceId) || lhDeviceId || u8(ephemeral)). Binds everything the server stores and uses at approval.
 */
export function joinTag(secret: Bytes, pairingId: string, publicKey: Bytes, name: string, lhDeviceId: string, ephemeral: boolean): Bytes {
	if (publicKey.length !== 32) throw new ProtocolError("bad_format", "public key must be 32 bytes");
	if (!LH_DEVICE_ID_RE.test(lhDeviceId)) throw new ProtocolError("bad_format", "lhDeviceId must look like dev_xxxxxxxx");
	return hash(
		32,
		concat("lhv1/pair/join", lengthPrefixed(checkPairingId(pairingId)), publicKey, lengthPrefixed(checkDeviceName(name)), lengthPrefixed(lhDeviceId), new Uint8Array([ephemeral ? 1 : 0])),
		secret,
	);
}

/** approveTag = H32(key = secret, "lhv1/pair/approve" || len(pairingId) || pairingId || pk || sealed). */
export function approveTag(secret: Bytes, pairingId: string, publicKey: Bytes, sealed: Bytes): Bytes {
	if (publicKey.length !== 32) throw new ProtocolError("bad_format", "public key must be 32 bytes");
	if (sealed.length !== SEALED_ROOT_BYTES) throw new ProtocolError("bad_format", "sealed root key has the wrong length");
	return hash(32, concat("lhv1/pair/approve", lengthPrefixed(checkPairingId(pairingId)), publicKey, sealed), secret);
}

export function verifyJoinTag(tag: Bytes, secret: Bytes, pairingId: string, publicKey: Bytes, name: string, lhDeviceId: string, ephemeral: boolean): void {
	if (!bytesEqual(tag, joinTag(secret, pairingId, publicKey, name, lhDeviceId, ephemeral))) throw new ProtocolError("pairing_tag", "The joining device did not prove it scanned this pairing code");
}

export function verifyApproveTag(tag: Bytes, secret: Bytes, pairingId: string, publicKey: Bytes, sealed: Bytes): void {
	if (!bytesEqual(tag, approveTag(secret, pairingId, publicKey, sealed))) throw new ProtocolError("pairing_tag", "The approval did not come from the device that showed this pairing code");
}

/** 6-digit code both devices show: u32be(H4("lhv1/pair/code" || pk)) mod 10^6, zero-padded. */
export function confirmationCode(publicKey: Bytes): string {
	if (publicKey.length !== 32) throw new ProtocolError("bad_format", "public key must be 32 bytes");
	const n = readU32be(hash(4, concat("lhv1/pair/code", publicKey)));
	return String(n % 1_000_000).padStart(6, "0");
}
