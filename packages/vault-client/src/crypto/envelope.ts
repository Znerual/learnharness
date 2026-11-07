// Record ids, record plaintext and record envelopes (ADR 0002, Records).

import { type Bytes, concat, fromUtf8, readU32be, toHex, u32be, utf8 } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { checkAccountId, checkCounter, checkRecordKind, type RecordKind } from "./framing.ts";
import { KEY_BYTES, NONCE_BYTES, randomBytes } from "./keys.ts";
import { hash } from "./unlock.ts";
import { sodium } from "./sodium.ts";

export const ENVELOPE_VERSION = 0x01;
const ENVELOPE_OVERHEAD = 1 + 4 + NONCE_BYTES + 16;
/** Largest record plaintext (ADR 0009: 32 MiB maximum record size). */
export const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export interface DocumentHeader {
	readonly kind: "doc";
	readonly path: string;
	readonly baseSeq: number;
	readonly deleted: boolean;
	readonly deviceId: string;
	readonly writtenAt: string;
}

export interface SegmentHeader {
	readonly kind: "seg";
	readonly path: string;
	readonly ledger: string;
	readonly deviceId: string;
	readonly offset: number;
	readonly writtenAt: string;
}

export type RecordHeader = DocumentHeader | SegmentHeader;

export interface RecordPlaintext {
	readonly header: RecordHeader;
	readonly body: Bytes;
}

/** recordId = hex(BLAKE2b-256(key = IK, message = record path)). */
export function recordId(ik: Bytes, path: string): string {
	checkPath(path);
	return toHex(hash(32, utf8(path), ik));
}

/** Throws unless `path` is a valid record path. The `lhv1/` prefix is reserved for key-derivation labels. */
export function checkPath(path: string): void {
	if (path.length === 0 || path.startsWith("lhv1/") || utf8(path).length > 1024 || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => p === "" || p === "." || p === "..")) {
		throw new ProtocolError("bad_format", `bad record path: ${JSON.stringify(path)}`);
	}
}

const DEVICE_ID_RE = /^dev_[0-9a-z]{8}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function checkHeader(h: unknown): RecordHeader {
	if (typeof h !== "object" || h === null) throw new ProtocolError("bad_format", "record header is not an object");
	const o = h as Record<string, unknown>;
	const str = (k: string): string => {
		const v = o[k];
		if (typeof v !== "string") throw new ProtocolError("bad_format", `record header field ${k} must be a string`);
		return v;
	};
	const int = (k: string): number => {
		const v = o[k];
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ProtocolError("bad_format", `record header field ${k} must be a non-negative integer`);
		return v;
	};
	const kind = checkRecordKind(str("kind"));
	const path = str("path");
	checkPath(path);
	const deviceId = str("deviceId");
	if (!DEVICE_ID_RE.test(deviceId)) throw new ProtocolError("bad_format", "record header deviceId is malformed");
	const writtenAt = str("writtenAt");
	if (!RFC3339_RE.test(writtenAt)) throw new ProtocolError("bad_format", "record header writtenAt is not RFC 3339");
	if (kind === "doc") {
		const deleted = o["deleted"];
		if (typeof deleted !== "boolean") throw new ProtocolError("bad_format", "record header field deleted must be a boolean");
		return { kind, path, baseSeq: int("baseSeq"), deleted, deviceId, writtenAt };
	}
	const ledger = str("ledger");
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(ledger)) throw new ProtocolError("bad_format", "record header ledger is malformed");
	return { kind, path, ledger, deviceId, offset: int("offset"), writtenAt };
}

/** Canonical header JSON: fields in the order of the protocol spec. */
export function encodeHeader(header: RecordHeader): Bytes {
	const h = checkHeader(header);
	const ordered =
		h.kind === "doc"
			? { kind: h.kind, path: h.path, baseSeq: h.baseSeq, deleted: h.deleted, deviceId: h.deviceId, writtenAt: h.writtenAt }
			: { kind: h.kind, path: h.path, ledger: h.ledger, deviceId: h.deviceId, offset: h.offset, writtenAt: h.writtenAt };
	return utf8(JSON.stringify(ordered));
}

/** plaintext = u32 header length || header JSON || body. */
export function encodePlaintext(p: RecordPlaintext): Bytes {
	const header = encodeHeader(p.header);
	if (header.length > MAX_HEADER_BYTES) throw new ProtocolError("bad_format", "record header too large");
	const out = concat(u32be(header.length), header, p.body);
	if (out.length > MAX_RECORD_BYTES) throw new ProtocolError("bad_format", "record exceeds 32 MiB");
	return out;
}

export function decodePlaintext(plain: Bytes): RecordPlaintext {
	if (plain.length < 4) throw new ProtocolError("bad_format", "record plaintext truncated");
	const len = readU32be(plain);
	if (len > MAX_HEADER_BYTES || plain.length < 4 + len) throw new ProtocolError("bad_format", "record header length out of range");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fromUtf8(plain.subarray(4, 4 + len)));
	} catch {
		throw new ProtocolError("bad_format", "record header is not valid UTF-8 JSON");
	}
	return { header: checkHeader(parsed), body: plain.slice(4 + len) };
}

export function recordAd(accountId: string, id: string, kind: RecordKind): Bytes {
	if (!/^[0-9a-f]{64}$/.test(id)) throw new ProtocolError("bad_format", "record id must be 64 lowercase hex characters");
	return concat("lhv1/rec/", checkAccountId(accountId), "/", id, "/", checkRecordKind(kind));
}

export interface SealedRecord {
	readonly recordId: string;
	readonly kind: RecordKind;
	readonly epoch: number;
	readonly envelope: Bytes;
}

/** Encrypts a record under VK_e. `nonce` is for test vectors only. */
export function encryptRecord(accountId: string, ik: Bytes, epoch: number, vk: Bytes, p: RecordPlaintext, nonce?: Bytes): SealedRecord {
	if (vk.length !== KEY_BYTES) throw new ProtocolError("bad_format", "vault key must be 32 bytes");
	const id = recordId(ik, p.header.path);
	const kind = p.header.kind;
	const n = nonce ?? randomBytes(NONCE_BYTES);
	const plain = encodePlaintext(p);
	const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, recordAd(accountId, id, kind), null, n, vk);
	sodium.memzero(plain);
	return { recordId: id, kind, epoch, envelope: concat(new Uint8Array([ENVELOPE_VERSION]), u32be(checkCounter(epoch, "epoch")), n, ct) };
}

/** The epoch an envelope claims, read without decrypting. */
export function envelopeEpoch(envelope: Bytes): number {
	if (envelope.length < ENVELOPE_OVERHEAD) throw new ProtocolError("bad_format", "envelope truncated");
	if (envelope[0] !== ENVELOPE_VERSION) throw new ProtocolError("bad_format", `unknown envelope version ${envelope[0]}`);
	return checkCounter(readU32be(envelope, 1), "epoch");
}

/**
 * Decrypts an envelope and checks that the header's path maps to `id` and its kind matches
 * (ADR 0002). `vaultKey` returns VK_e for an epoch, or undefined if this device does not hold it.
 */
export function decryptRecord(accountId: string, ik: Bytes, id: string, kind: RecordKind, envelope: Bytes, vaultKey: (epoch: number) => Bytes | undefined): RecordPlaintext {
	const epoch = envelopeEpoch(envelope);
	const vk = vaultKey(epoch);
	if (!vk) throw new ProtocolError("decrypt_failed", `no vault key for epoch ${epoch}`);
	let plain: Bytes;
	try {
		plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, envelope.subarray(5 + NONCE_BYTES), recordAd(accountId, id, kind), envelope.subarray(5, 5 + NONCE_BYTES), vk);
	} catch {
		throw new ProtocolError("decrypt_failed", `cannot decrypt record ${id}`);
	}
	const p = decodePlaintext(plain);
	sodium.memzero(plain);
	if (p.header.kind !== kind) throw new ProtocolError("wrong_record", `record ${id} claims kind ${p.header.kind}, expected ${kind}`);
	if (recordId(ik, p.header.path) !== id) throw new ProtocolError("wrong_record", `record ${id} does not match its header path`);
	return p;
}
