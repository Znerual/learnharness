// The vault server and the other devices of an account are not trusted to send sane data.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiClient, MAX_BLOB_RESPONSE, NetworkError, readCapped } from "../src/api/client.ts";
import type { ChangesResponse } from "../src/api/types.ts";
import { MAX_INDEX_ENTRIES, MAX_SLOT_SPAN, parseIndex, parseRegistry } from "../src/sync/chains.ts";
import { checkChangesPage } from "../src/sync/engine.ts";

const enc = new TextEncoder();
const jsonl = (rows: unknown[]) => enc.encode(rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
const sha = "ab".repeat(32);

describe("plugin index and registry from another device", () => {
	it("drops index entries whose numbers would drive huge loops", () => {
		const good = { path: "decks/a.json", full: 3, head: 9, size: 120, sha256: sha };
		const rows = [
			good,
			{ ...good, path: "b.json", head: 4_000_000_000 },
			{ ...good, path: "c.json", full: 1, head: MAX_SLOT_SPAN + 2 },
			{ ...good, path: "d.json", full: 9, head: 3 },
			{ ...good, path: "e.json", full: 0 },
			{ ...good, path: "f.json", full: 1.5 },
			{ ...good, path: "g.json", head: "9" },
			{ ...good, path: "h.json", head: Number.MAX_VALUE },
			{ ...good, path: "../escape.json" },
			{ ...good, path: "run.js" },
			{ ...good, path: "i.json", sha256: "zz" },
			{ ...good, path: "j.json", size: -1 },
			{ ...good }, // the same path twice
			null, 7, "x", [good],
		];
		assert.deepEqual(parseIndex(jsonl(rows)), [good]);
		assert.deepEqual(parseIndex(null), []);
	});

	it("bounds the number of index entries", () => {
		const rows = Array.from({ length: MAX_INDEX_ENTRIES + 50 }, (_, i) => ({ path: `f${i}.json`, full: 1, head: 1, size: 1, sha256: sha }));
		assert.equal(parseIndex(jsonl(rows)).length, MAX_INDEX_ENTRIES);
	});

	it("drops registry entries that are not plugin references", () => {
		const good = { origin: "community", id: "flash-cards", name: "Flashcards", source: "https://example.org/x" };
		const rows = [good, { ...good, origin: "system" }, { ...good, id: "../x" }, { ...good, id: "A" }, { ...good, name: 5 }, { ...good, name: "n".repeat(500) },
			{ ...good, extra: "ignored", id: "other" }, { ...good }, null];
		assert.deepEqual(parseRegistry(jsonl(rows)), [good, { ...good, id: "other" }]);
	});
});

describe("change pages from the server", () => {
	const page = (o: Partial<ChangesResponse>) => ({ changes: [], cursor: 10, more: false, lastSeq: 10, generation: 1, epoch: 1, ...o }) as ChangesResponse;
	it("accepts a page that moves forward or ends", () => {
		checkChangesPage(page({ cursor: 10, more: false }), 10);
		checkChangesPage(page({ cursor: 11, more: true }), 10);
	});
	it("refuses a cursor that does not move, moves back or is not a number", () => {
		assert.throws(() => checkChangesPage(page({ cursor: 10, more: true }), 10), /forward/);
		assert.throws(() => checkChangesPage(page({ cursor: 3, more: false }), 10), /backwards/);
		assert.throws(() => checkChangesPage(page({ cursor: Number.NaN }), 10), /malformed/);
		assert.throws(() => checkChangesPage(page({ changes: "x" as never }), 10), /malformed/);
		assert.throws(() => checkChangesPage(page({ changes: new Array(1001).fill({}) as never, cursor: 2000, more: true }), 10), /more changes/);
	});
});

describe("answers from the server", () => {
	const endless = () => new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1 << 20)); } });

	it("stops reading a body that is larger than allowed", async () => {
		await assert.rejects(readCapped(new Response(endless()), 3 << 20), NetworkError);
		await assert.rejects(readCapped(new Response("x", { headers: { "content-length": "999999999999" } }), 1000), NetworkError);
		assert.equal((await readCapped(new Response("hello"), 1000)).length, 5);
	});

	it("caps blobs, refuses hashes that are not hashes, and never follows redirects", async () => {
		const seen: RequestInit[] = [];
		const api = new ApiClient("https://vault.test", async (_url, init) => {
			seen.push(init ?? {});
			return new Response(endless());
		});
		await assert.rejects(api.blob(sha, { token: "t" }), /too large/);
		await assert.rejects(api.blob("../../v1/account", { token: "t" }), /not a SHA-256/);
		assert.equal(seen.length, 1, "the malformed hash never reached the network");
		assert.equal(seen[0]?.redirect, "error");
		assert.ok(seen[0]?.signal, "a time limit is set");
		assert.ok(MAX_BLOB_RESPONSE > 32 * 1024 * 1024);

		const json = new ApiClient("https://vault.test", async (_url, init) => {
			seen.push(init ?? {});
			return new Response(JSON.stringify({ ok: true }));
		});
		assert.deepEqual(await json.get("/v1/account", { token: "t" }), { ok: true });
		assert.equal(seen[1]?.redirect, "error");
		assert.ok(seen[1]?.signal);
	});

	it("reads an error body with a cap", async () => {
		const api = new ApiClient("https://vault.test", async () => new Response(endless(), { status: 500 }));
		await assert.rejects(api.get("/v1/account"), (e: Error) => e.name === "ApiError" && /http_500/.test(e.message));
	});
});
