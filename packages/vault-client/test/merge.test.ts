import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { matchSequences, merge3, mergeKindFor } from "../src/sync/merge.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const j = (v: unknown) => enc.encode(JSON.stringify(v));
const mergeJson = (b: unknown, l: unknown, r: unknown) => {
	const res = merge3(b === null ? null : j(b), j(l), j(r), "json");
	return { value: JSON.parse(dec.decode(res.merged)) as unknown, conflicts: res.conflicts };
};
const mergeText = (b: string | null, l: string, r: string) => {
	const res = merge3(b === null ? null : enc.encode(b), enc.encode(l), enc.encode(r), "text");
	return { text: dec.decode(res.merged), conflicts: res.conflicts };
};

describe("merge kinds", () => {
	test("by extension", () => {
		assert.equal(mergeKindFor("flashcards.json"), "json");
		assert.equal(mergeKindFor("reviews/abc.jsonl"), "text");
		assert.equal(mergeKindFor("sources/x.md"), "text");
		assert.equal(mergeKindFor("notes.TXT"), "text");
		assert.equal(mergeKindFor("drawing.png"), "binary");
	});
});

describe("sequence matching", () => {
	test("matches a longest common subsequence", () => {
		const pairs = matchSequences([1, 2, 3, 4, 5], [1, 3, 9, 4, 5, 6]);
		assert.deepEqual(pairs, [[0, 0], [2, 1], [3, 3], [4, 4]]);
		assert.deepEqual(matchSequences([], [1]), []);
		assert.equal(matchSequences([1, 2, 3], [4, 5, 6], 1), null, "edit distance over the limit");
	});
});

describe("JSON merge", () => {
	test("objects merge key by key", () => {
		const r = mergeJson({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3, c: 4 });
		assert.deepEqual(r.value, { a: 2, b: 3, c: 4 });
		assert.deepEqual(r.conflicts, []);
	});
	test("the same value changed on both sides takes the remote value", () => {
		const r = mergeJson({ s: { due: 1 } }, { s: { due: 2 } }, { s: { due: 3 } });
		assert.deepEqual(r.value, { s: { due: 3 } });
		assert.deepEqual(r.conflicts, ["/s/due"]);
	});
	test("edit wins over delete, deletions on one side apply", () => {
		assert.deepEqual(mergeJson({ a: 1, b: 1 }, { b: 1 }, { a: 2, b: 1 }).value, { a: 2, b: 1 }, "deleted locally, changed remotely");
		assert.deepEqual(mergeJson({ a: 1, b: 1 }, { a: 2, b: 1 }, { b: 1 }).value, { a: 2, b: 1 }, "changed locally, deleted remotely");
		assert.deepEqual(mergeJson({ a: 1, b: 1 }, { b: 1 }, { a: 1, b: 2 }).value, { b: 2 }, "deleted locally, other key changed remotely");
	});
	test("arrays of objects with ids merge as sets", () => {
		const base = { decks: [{ id: "d1", name: "A" }, { id: "d2", name: "B" }] };
		const local = { decks: [{ id: "d1", name: "A2" }, { id: "d2", name: "B" }, { id: "d3", name: "C" }] };
		const remote = { decks: [{ id: "d0", name: "Z" }, { id: "d1", name: "A" }, { id: "d2", name: "B3" }] };
		const r = mergeJson(base, local, remote);
		assert.deepEqual(r.value, { decks: [{ id: "d0", name: "Z" }, { id: "d1", name: "A2" }, { id: "d2", name: "B3" }, { id: "d3", name: "C" }] });
		assert.deepEqual(r.conflicts, []);
		// A deck deleted on one side and changed on the other comes back with the change.
		const back = mergeJson(base, { decks: [{ id: "d2", name: "B" }] }, { decks: [{ id: "d1", name: "A9" }, { id: "d2", name: "B" }] });
		assert.deepEqual(back.value, { decks: [{ id: "d1", name: "A9" }, { id: "d2", name: "B" }] });
	});
	test("other arrays merge element by element, keeping appends from both sides", () => {
		const r = mergeJson({ xs: [1, 2, 3] }, { xs: [1, 2, 3, 4] }, { xs: [0, 1, 2, 3, 5] });
		assert.deepEqual(r.value, { xs: [0, 1, 2, 3, 5, 4] });
		assert.deepEqual(r.conflicts, []);
		const c = mergeJson({ xs: [1, 2, 3] }, { xs: [1, 7, 3] }, { xs: [1, 8, 3] });
		assert.deepEqual(c.value, { xs: [1, 8, 3] });
		assert.deepEqual(c.conflicts, ["/xs"]);
	});
	test("no common ancestor: union of keys, remote wins on differences", () => {
		const r = mergeJson(null, { a: 1, b: 2 }, { a: 3, c: 4 });
		assert.deepEqual(r.value, { a: 3, c: 4, b: 2 });
		assert.deepEqual(r.conflicts, ["/a"]);
	});
	test("keeps the remote file's formatting", () => {
		const base = enc.encode('{\n  "a": 1\n}\n');
		const local = enc.encode('{\n  "a": 2\n}\n');
		const remote = enc.encode('{\n  "a": 1,\n  "b": 1\n}\n');
		assert.equal(dec.decode(merge3(base, local, remote, "json").merged), '{\n  "a": 2,\n  "b": 1\n}\n');
	});
	test("invalid JSON falls back to a line merge", () => {
		const r = merge3(enc.encode("{"), enc.encode("{x"), enc.encode("{y"), "json");
		assert.equal(dec.decode(r.merged), "{y");
		assert.equal(r.conflicts.length, 1);
	});
	test("deterministic and stable when merged twice", () => {
		const b = { decks: [{ id: "d1", n: 1 }], m: { x: 1 } };
		const l = { decks: [{ id: "d1", n: 2 }, { id: "d2", n: 1 }], m: { x: 1, y: 2 } };
		const r = { decks: [{ id: "d1", n: 1 }, { id: "d3", n: 1 }], m: { x: 5 } };
		const first = merge3(j(b), j(l), j(r), "json").merged;
		assert.deepEqual(merge3(j(b), j(l), j(r), "json").merged, first);
		assert.deepEqual(merge3(j(r), first, j(r), "json").merged, first, "merging the result against the same remote changes nothing");
	});
});

describe("Flashcards-shaped files edited on two devices", () => {
	const card = (id: string, q: string, due = 1) => ({ id, cues: [{ id: `${id}-c`, question: q, answer: "a" }], schedule: { due, reps: 1 } });
	const base = { version: 1, revision: 5, settings: { retention: 0.9 }, decks: [{ id: "d1", name: "Bio", propositionIds: ["p1", "p2"] }, { id: "d2", name: "Chem", propositionIds: ["p3"] }], propositions: { p1: card("p1", "Q1"), p2: card("p2", "Q2"), p3: card("p3", "Q3") }, reviews: [{ id: "r1", p: "p1" }] };
	test("different decks renamed, cards added on both, one card edited on both, a deck deleted on one and changed on the other", () => {
		const local = structuredClone(base) as typeof base & { propositions: Record<string, unknown> };
		local.revision = 6;
		(local.decks[0] as { name: string }).name = "Biology";
		local.decks[0]?.propositionIds.push("p4");
		local.propositions["p4"] = card("p4", "Q4 local");
		(local.propositions["p2"] as ReturnType<typeof card>).cues[0]!.question = "Q2 local";
		local.decks = local.decks.filter((d) => d.id !== "d2");
		local.reviews.push({ id: "r2", p: "p2" });

		const remote = structuredClone(base) as typeof base & { propositions: Record<string, unknown> };
		remote.revision = 6;
		(remote.decks[1] as { name: string }).name = "Chemistry";
		remote.decks[1]?.propositionIds.push("p5");
		remote.propositions["p5"] = card("p5", "Q5 remote");
		(remote.propositions["p2"] as ReturnType<typeof card>).cues[0]!.question = "Q2 remote";
		remote.reviews.push({ id: "r3", p: "p5" });

		const r = mergeJson(base, local, remote);
		const v = r.value as typeof base & { propositions: Record<string, ReturnType<typeof card>> };
		assert.deepEqual(v.decks.map((d) => d.name), ["Biology", "Chemistry"], "both renames kept; the deck deleted locally comes back with the remote change");
		assert.deepEqual(v.decks[0]?.propositionIds, ["p1", "p2", "p4"]);
		assert.deepEqual(v.decks[1]?.propositionIds, ["p3", "p5"]);
		assert.deepEqual(Object.keys(v.propositions).sort(), ["p1", "p2", "p3", "p4", "p5"]);
		assert.equal(v.propositions["p2"]?.cues[0]?.question, "Q2 remote", "both edited: remote wins");
		assert.deepEqual(v.reviews.map((x) => x.id), ["r1", "r2", "r3"], "reviews from both devices kept; a local insertion keeps its place after its local predecessor");
		assert.equal(v.revision, 6);
		assert.deepEqual(r.conflicts, ["/propositions/p2/cues/p2-c/question"]);
	});
});

describe("text and binary", () => {
	test("lines merge; appends on both sides are kept", () => {
		const r = mergeText("a\nb\n", "a\nb\nlocal\n", "a\nb\nremote\n");
		assert.equal(r.text, "a\nb\nremote\nlocal\n");
		assert.deepEqual(r.conflicts, []);
		assert.equal(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n").text, "A\nb\nC\n");
	});
	test("overlapping line changes take the remote lines", () => {
		const r = mergeText("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
		assert.equal(r.text, "a\nY\nc\n");
		assert.equal(r.conflicts.length, 1);
	});
	test("binary: one-sided changes apply, both-sided take the remote version", () => {
		const b = Uint8Array.from([1]);
		const l = Uint8Array.from([2]);
		const r = Uint8Array.from([3]);
		assert.deepEqual(merge3(b, l, b, "binary").merged, l);
		assert.deepEqual(merge3(b, b, r, "binary").merged, r);
		const both = merge3(b, l, r, "binary");
		assert.deepEqual(both.merged, r);
		assert.deepEqual(both.conflicts, ["(file)"]);
	});
});

describe("merging hostile input stays bounded", () => {
	test("deeply nested JSON falls back to the remote version with a conflict", () => {
		const deep = (leaf: string, n: number) => "[".repeat(n) + JSON.stringify(leaf) + "]".repeat(n);
		const res = merge3(enc.encode(deep("b", 3000)), enc.encode(deep("l", 3000)), enc.encode(deep("r", 3000)), "json");
		assert.equal(dec.decode(res.merged), deep("r", 3000));
		assert.ok(res.conflicts.length > 0);
		const objects = (leaf: string, n: number) => '{"a":'.repeat(n) + JSON.stringify(leaf) + "}".repeat(n);
		const res2 = merge3(enc.encode(objects("b", 200)), enc.encode(objects("l", 200)), enc.encode(objects("r", 200)), "json");
		assert.equal(dec.decode(res2.merged), objects("r", 200));
		assert.ok(res2.conflicts.length > 0);
	});

	test("a key named __proto__ stays a key of the merged file", () => {
		const base = '{"a":1}';
		const local = '{"a":1,"x":2}';
		const remote = '{"a":1,"__proto__":{"polluted":true}}';
		const res = merge3(enc.encode(base), enc.encode(local), enc.encode(remote), "json");
		const text = dec.decode(res.merged);
		assert.ok(text.includes('"__proto__"'), text);
		assert.ok(text.includes('"x":2'), text);
		assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
	});

	test("two large files that differ everywhere do not exhaust memory or time", () => {
		const lines = (tag: string) => enc.encode(Array.from({ length: 150_000 }, (_, i) => `${tag}${i}`).join("\n") + "\n");
		const t0 = Date.now();
		const res = merge3(lines("b"), lines("l"), lines("r"), "text");
		assert.ok(Date.now() - t0 < 20_000, "bounded time");
		assert.ok(res.conflicts.length > 0);
		assert.ok(res.merged.length > 0);
	});

	test("a large array of ids merges in bounded time", () => {
		const arr = (n: number, extra: string) => Array.from({ length: n }, (_, i) => ({ id: `${extra}${i}` }));
		const t0 = Date.now();
		const res = merge3(j(arr(10, "b")), j(arr(40_000, "l")), j(arr(40_000, "r")), "json");
		assert.ok(Date.now() - t0 < 20_000, "bounded time");
		assert.ok(res.merged.length > 0);
	});

	test("matchSequences gives up instead of growing its trace without bound", () => {
		const a = Array.from({ length: 300_000 }, (_, i) => i);
		const b = Array.from({ length: 300_000 }, (_, i) => i + 1_000_000);
		assert.equal(matchSequences(a, b), null);
	});
});
