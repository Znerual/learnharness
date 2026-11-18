import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { applyDelta, checkChainResult, DELTA_COPY, DELTA_INSERT, decodePlaintext, encodeDelta, encodePlaintext, MAX_DELTA_OPS, ProtocolError } from "../src/crypto/index.ts";

const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const code = (f: () => unknown) => {
	try {
		f();
	} catch (e) {
		return e instanceof ProtocolError ? e.code : `other: ${(e as Error).message}`;
	}
	return "no error";
};

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function roundTrip(base: Uint8Array, next: Uint8Array): Uint8Array | null {
	const d = encodeDelta(base, next);
	if (d) assert.deepEqual(applyDelta(base, d, { maxSize: next.length }), next);
	return d;
}

/** A Flashcards-like store: one-line JSON with a revision near the start and a growing review list. */
function store(revision: number, reviews: number, due: number): Uint8Array {
	const propositions: Record<string, unknown> = {};
	for (let p = 0; p < 400; p++) propositions[`p${p}`] = { id: `p${p}`, cues: [{ id: `c${p}`, question: `What is fact number ${p}?`, answer: `It is the answer ${p * 7}.` }], schedule: { due: p === 17 ? due : 1_000 + p, stability: 2.5, reps: 3 } };
	const list = Array.from({ length: reviews }, (_, r) => ({ id: `r${r}`, propositionId: `p${r % 400}`, rating: 3, at: 1_700_000_000_000 + r * 1000 }));
	return enc.encode(JSON.stringify({ version: 1, revision, settings: { retention: 0.9 }, decks: [{ id: "d1", name: "Deck", propositionIds: Object.keys(propositions) }], propositions, reviews: list, batches: [] }));
}

describe("delta", () => {
	test("random edits round-trip", () => {
		const r = rng(42);
		for (let n = 0; n < 200; n++) {
			const base = new Uint8Array(Math.floor(r() * 5000));
			for (let i = 0; i < base.length; i++) base[i] = Math.floor(r() * 256);
			const next = Array.from(base);
			for (let e = 0; e < 1 + Math.floor(r() * 6); e++) {
				const at = Math.floor(r() * (next.length + 1));
				const kind = r();
				if (kind < 0.4) next.splice(at, Math.floor(r() * 50));
				else if (kind < 0.8) next.splice(at, 0, ...Array.from({ length: Math.floor(r() * 80) }, () => Math.floor(r() * 256)));
				else for (let k = at; k < Math.min(next.length, at + 10); k++) next[k] = Math.floor(r() * 256);
			}
			roundTrip(base, Uint8Array.from(next));
		}
	});

	test("edge cases round-trip or fall back to a full slot", () => {
		const a = enc.encode("x".repeat(1000));
		assert.equal(encodeDelta(new Uint8Array(0), enc.encode("short")), null, "nothing to copy: full slot");
		assert.equal(encodeDelta(a, new Uint8Array(0)), null, "an empty file is a full slot");
		assert.notEqual(roundTrip(a, a), null, "an unchanged file is one COPY");
		roundTrip(a, enc.encode(`${"x".repeat(1000)}tail`));
		roundTrip(a, enc.encode(`head${"x".repeat(1000)}`));
	});

	test("a Flashcards rating costs well under 2 KB", () => {
		const before = store(10, 3000, 5000);
		const after = enc.encode(`${new TextDecoder().decode(store(11, 3001, 9000))}`);
		const d = roundTrip(before, after);
		assert.ok(d, "delta written");
		assert.ok(d.length < 2048, `delta is ${d.length} bytes for a ${after.length}-byte file`);
	});

	test("an append costs the appended bytes plus one COPY", () => {
		const base = enc.encode('{"r":1}\n'.repeat(500));
		const next = enc.encode(`${'{"r":1}\n'.repeat(500)}{"r":2}\n`);
		const d = roundTrip(base, next);
		assert.ok(d && d.length <= 9 + 5 + 8 + 64, `append delta is ${d?.length} bytes`);
	});

	test("deterministic", () => {
		const a = store(1, 100, 1);
		const b = store(2, 101, 2);
		assert.deepEqual(encodeDelta(a, b), encodeDelta(a, b));
	});

	test("readers refuse malformed deltas", () => {
		const base = enc.encode("0123456789");
		const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
		const cases: [string, number[], number][] = [
			["unknown operation", [0x03], 100],
			["truncated COPY", [DELTA_COPY, 0, 0, 0, 0, 0, 0], 100],
			["empty COPY", [DELTA_COPY, ...u32(0), ...u32(0)], 100],
			["COPY outside the base", [DELTA_COPY, ...u32(5), ...u32(6)], 100],
			["truncated INSERT bytes", [DELTA_INSERT, ...u32(4), 1, 2], 100],
			["empty INSERT", [DELTA_INSERT, ...u32(0)], 100],
			["result over the limit", [DELTA_COPY, ...u32(0), ...u32(10)], 9],
		];
		for (const [why, bytes, maxSize] of cases) assert.equal(code(() => applyDelta(base, Uint8Array.from(bytes), { maxSize })), "bad_delta", why);
		const many = new Uint8Array(9 * (MAX_DELTA_OPS + 1));
		for (let k = 0; k <= MAX_DELTA_OPS; k++) many.set([DELTA_COPY, ...u32(0), ...u32(1)], k * 9);
		assert.equal(code(() => applyDelta(base, many, { maxSize: 1 << 20 })), "bad_delta", "too many operations");
		const out = applyDelta(base, Uint8Array.from([DELTA_COPY, ...u32(2), ...u32(3), DELTA_INSERT, ...u32(1), 0x41]), { maxSize: 100 });
		assert.equal(new TextDecoder().decode(out), "234A");
		assert.equal(code(() => checkChainResult(out, 4, sha(out))), "no error");
		assert.equal(code(() => checkChainResult(out, 5, sha(out))), "bad_delta");
		assert.equal(code(() => checkChainResult(out, 4, sha(base))), "bad_delta");
	});
});

describe("chain header", () => {
	const h = { kind: "doc" as const, path: "pf/core/flashcards/flashcards.json/000000000002", baseSeq: 0, deleted: false, deviceId: "dev_ab12cd34", writtenAt: "2026-11-18T10:00:00Z" };
	const s = "a".repeat(64);
	test("round-trips and orders fields", () => {
		const full = { ...h, chain: { type: "full" as const, size: 3, sha256: s } };
		const delta = { ...h, chain: { type: "delta" as const, size: 3, sha256: s, baseSha256: "b".repeat(64) } };
		for (const header of [h, full, delta]) assert.deepEqual(decodePlaintext(encodePlaintext({ header, body: new Uint8Array([1]) })).header, header);
		const text = new TextDecoder().decode(encodePlaintext({ header: delta, body: new Uint8Array(0) }).subarray(4));
		assert.match(text, /"writtenAt":"[^"]+","chain":\{"type":"delta","size":3,"sha256":"a{64}","baseSha256":"b{64}"\}\}$/);
	});
	test("refuses malformed chain fields", () => {
		const bad: unknown[] = [
			{ type: "full", size: 3, sha256: s, baseSha256: s },
			{ type: "delta", size: 3, sha256: s },
			{ type: "other", size: 3, sha256: s },
			{ type: "full", size: -1, sha256: s },
			{ type: "full", size: 3, sha256: "A".repeat(64) },
			"full",
		];
		for (const chain of bad) assert.equal(code(() => encodePlaintext({ header: { ...h, chain } as never, body: new Uint8Array(0) })), "bad_format", JSON.stringify(chain));
		assert.equal(code(() => encodePlaintext({ header: { ...h, deleted: true, chain: { type: "full", size: 0, sha256: s } }, body: new Uint8Array(0) })), "bad_format", "tombstone with chain");
	});
});
