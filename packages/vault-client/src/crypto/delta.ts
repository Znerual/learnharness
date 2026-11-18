// Delta slots of a delta chain (ADR 0014, spec section 8): a list of COPY and INSERT operations
// that turns the previous version of a file into the next one.
//
//   op = 0x01 || u32(offset) || u32(length)     COPY bytes [offset, offset+length) of the previous version
//      | 0x02 || u32(length) || bytes(length)   INSERT these bytes
//
// Only the operations are part of the format. The encoder below finds copies with a rolling hash
// over 64-byte blocks; any other encoder producing valid operations is equally acceptable.

import { createHash } from "node:crypto";

import { type Bytes, readU32be } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";

export const DELTA_COPY = 0x01;
export const DELTA_INSERT = 0x02;
/** A reader refuses a delta with more operations than this. */
export const MAX_DELTA_OPS = 65_536;
/** Block size of the encoder's rolling hash. */
export const DELTA_BLOCK = 64;

export interface ApplyDeltaLimits {
	/** Largest permitted result in bytes (the file's per-file limit, at most the header's size). */
	maxSize: number;
	/** Largest permitted number of operations; defaults to MAX_DELTA_OPS. */
	maxOps?: number;
}

type Op = { copy: true; offset: number; length: number } | { copy: false; at: number; length: number };

function sha256Hex(b: Bytes): string {
	return createHash("sha256").update(b).digest("hex");
}

function bad(message: string): ProtocolError {
	return new ProtocolError("bad_delta", message);
}

/**
 * Applies a delta to `base` and returns the result. Refuses (ProtocolError "bad_delta") an unknown
 * operation, a truncated operation, an empty operation, a COPY range outside `base`, a result over
 * `maxSize`, and more than `maxOps` operations. The caller checks the result's size and SHA-256
 * against the slot header (`checkChainResult`).
 */
export function applyDelta(base: Bytes, delta: Bytes, limits: ApplyDeltaLimits): Bytes {
	const maxOps = Math.min(limits.maxOps ?? MAX_DELTA_OPS, MAX_DELTA_OPS);
	const ops: Op[] = [];
	let size = 0;
	let i = 0;
	while (i < delta.length) {
		if (ops.length >= maxOps) throw bad(`delta has more than ${maxOps} operations`);
		const op = delta[i] as number;
		if (op === DELTA_COPY) {
			if (i + 9 > delta.length) throw bad("truncated COPY operation");
			const offset = readU32be(delta, i + 1);
			const length = readU32be(delta, i + 5);
			if (length === 0) throw bad("empty COPY operation");
			if (offset + length > base.length) throw bad("COPY range lies outside the previous version");
			ops.push({ copy: true, offset, length });
			size += length;
			i += 9;
		} else if (op === DELTA_INSERT) {
			if (i + 5 > delta.length) throw bad("truncated INSERT operation");
			const length = readU32be(delta, i + 1);
			if (length === 0) throw bad("empty INSERT operation");
			if (i + 5 + length > delta.length) throw bad("truncated INSERT bytes");
			ops.push({ copy: false, at: i + 5, length });
			size += length;
			i += 5 + length;
		} else {
			throw bad(`unknown delta operation 0x${op.toString(16).padStart(2, "0")}`);
		}
		if (size > limits.maxSize) throw bad(`delta result exceeds ${limits.maxSize} bytes`);
	}
	const out = new Uint8Array(size);
	let o = 0;
	for (const p of ops) {
		if (p.copy) out.set(base.subarray(p.offset, p.offset + p.length), o);
		else out.set(delta.subarray(p.at, p.at + p.length), o);
		o += p.length;
	}
	return out;
}

/** Throws "bad_delta" unless `result` has the size and SHA-256 the slot header declares. */
export function checkChainResult(result: Bytes, size: number, sha256: string): void {
	if (result.length !== size) throw bad(`chain result has ${result.length} bytes, the header declares ${size}`);
	if (sha256Hex(result) !== sha256) throw bad("chain result does not match the header's SHA-256");
}

// ---------------------------------------------------------------- encoder

const MOD = 65_521;

/** Adler-32 style weak checksum of `b[at, at+DELTA_BLOCK)`, as two 16-bit sums. */
function weak(b: Bytes, at: number): { a: number; s: number } {
	let a = 0;
	let s = 0;
	for (let k = 0; k < DELTA_BLOCK; k++) {
		a = (a + (b[at + k] as number)) % MOD;
		s = (s + a) % MOD;
	}
	return { a, s };
}

function key(a: number, s: number): number {
	return s * MOD + a;
}

class Writer {
	private chunks: Bytes[] = [];
	private length = 0;
	ops = 0;
	private lastCopy: { offset: number; length: number } | null = null;

	private flushCopy(): void {
		if (!this.lastCopy) return;
		const h = new Uint8Array(9);
		h[0] = DELTA_COPY;
		new DataView(h.buffer).setUint32(1, this.lastCopy.offset);
		new DataView(h.buffer).setUint32(5, this.lastCopy.length);
		this.chunks.push(h);
		this.length += 9;
		this.ops++;
		this.lastCopy = null;
	}

	copy(offset: number, length: number): void {
		if (length === 0) return;
		if (this.lastCopy && this.lastCopy.offset + this.lastCopy.length === offset) {
			this.lastCopy.length += length;
			return;
		}
		this.flushCopy();
		this.lastCopy = { offset, length };
	}

	insert(bytes: Bytes): void {
		if (bytes.length === 0) return;
		this.flushCopy();
		const h = new Uint8Array(5);
		h[0] = DELTA_INSERT;
		new DataView(h.buffer).setUint32(1, bytes.length);
		this.chunks.push(h, bytes);
		this.length += 5 + bytes.length;
		this.ops++;
	}

	finish(): Bytes {
		this.flushCopy();
		const out = new Uint8Array(this.length);
		let o = 0;
		for (const c of this.chunks) {
			out.set(c, o);
			o += c.length;
		}
		return out;
	}
}

/**
 * Encodes `next` as a delta against `base`. Returns null when a delta would not be smaller than
 * `next` itself or would need more than MAX_DELTA_OPS operations; the writer then writes a full slot.
 * Deterministic: the same inputs give the same bytes.
 */
export function encodeDelta(base: Bytes, next: Bytes): Bytes | null {
	const w = new Writer();
	// Index the base's aligned blocks by weak checksum.
	const index = new Map<number, number[]>();
	for (let at = 0; at + DELTA_BLOCK <= base.length; at += DELTA_BLOCK) {
		const { a, s } = weak(base, at);
		const k = key(a, s);
		const list = index.get(k);
		if (list) list.push(at);
		else index.set(k, [at]);
	}
	let pending = 0; // start of bytes not yet emitted
	let i = 0;
	let a = 0;
	let s = 0;
	let rolling = false;
	while (i + DELTA_BLOCK <= next.length) {
		if (!rolling) {
			({ a, s } = weak(next, i));
			rolling = true;
		}
		let matched = -1;
		const candidates = index.get(key(a, s));
		if (candidates) {
			for (const at of candidates) {
				let k = 0;
				while (k < DELTA_BLOCK && base[at + k] === next[i + k]) k++;
				if (k === DELTA_BLOCK) {
					matched = at;
					break;
				}
			}
		}
		if (matched >= 0) {
			// Extend backwards into the pending bytes, then forwards.
			let back = 0;
			while (back < i - pending && back < matched && base[matched - back - 1] === next[i - back - 1]) back++;
			let fwd = DELTA_BLOCK;
			while (matched + fwd < base.length && i + fwd < next.length && base[matched + fwd] === next[i + fwd]) fwd++;
			w.insert(next.subarray(pending, i - back));
			w.copy(matched - back, back + fwd);
			i += fwd;
			pending = i;
			rolling = false;
			if (w.ops > MAX_DELTA_OPS) return null;
			continue;
		}
		// Roll one byte forward.
		if (i + DELTA_BLOCK < next.length) {
			const out = next[i] as number;
			const inn = next[i + DELTA_BLOCK] as number;
			a = (a - out + inn + MOD) % MOD;
			s = (s - ((DELTA_BLOCK * out) % MOD) + a + MOD) % MOD;
		}
		i++;
	}
	w.insert(next.subarray(pending));
	const delta = w.finish();
	if (w.ops > MAX_DELTA_OPS || delta.length >= next.length) return null;
	return delta;
}
