// Byte helpers shared by the protocol code. No secrets are ever turned into strings here
// except by the explicit encoders, which callers use only for public values.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type Bytes = Uint8Array;

export function utf8(s: string): Bytes {
	return encoder.encode(s);
}

export function fromUtf8(b: Bytes): string {
	return decoder.decode(b);
}

/** Concatenates byte arrays and strings (strings are UTF-8 encoded). */
export function concat(...parts: ReadonlyArray<Bytes | string>): Bytes {
	const chunks = parts.map((p) => (typeof p === "string" ? utf8(p) : p));
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

export function u32be(n: number): Bytes {
	if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a u32: ${n}`);
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n, false);
	return b;
}

export function readU32be(b: Bytes, offset = 0): number {
	if (b.length < offset + 4) throw new RangeError("buffer too short for u32");
	return new DataView(b.buffer, b.byteOffset + offset, 4).getUint32(0, false);
}

/** A variable-length field prefixed with its byte length as u32 big-endian (ADR 0002, Framing). */
export function lengthPrefixed(field: Bytes | string): Bytes {
	const b = typeof field === "string" ? utf8(field) : field;
	return concat(u32be(b.length), b);
}

export function toHex(b: Bytes): string {
	let s = "";
	for (const x of b) s += x.toString(16).padStart(2, "0");
	return s;
}

export function fromHex(s: string): Bytes {
	if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error("invalid hex");
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
	return out;
}

/** Node's Buffer when present (fast for record batches of many MiB); browsers use btoa/atob. */
const NodeBuffer = (globalThis as { Buffer?: { from(b: ArrayBufferLike | string, o?: number | string, l?: number): Uint8Array & { toString(enc: string): string } } }).Buffer;

/** base64url without padding, the encoding of every binary value in JSON (protocol spec). Works in Node and browsers. */
export function toB64(b: Bytes): string {
	if (NodeBuffer) return NodeBuffer.from(b.buffer, b.byteOffset, b.length).toString("base64url");
	let bin = "";
	for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(s: string): Bytes {
	if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
	if (NodeBuffer) {
		const nb = NodeBuffer.from(s, "base64url");
		if (nb.toString("base64url") !== s) throw new Error("non-canonical base64url");
		return new Uint8Array(nb.buffer, nb.byteOffset, nb.length).slice();
	}
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	if (toB64(out) !== s) throw new Error("non-canonical base64url");
	return out;
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
}
