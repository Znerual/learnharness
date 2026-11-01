/**
 * POST /api/custom-providers/[id] — the connect policy around manually typed model
 * ids. Two rules earn a route test (the pure pieces live in
 * custom-endpoint.test.ts):
 *   1. Typed ids make a FAILED probe survivable, but never a rejected key.
 *   2. A failed probe never shrinks the snapshot it already stored: that prune
 *      would take the model metadata and the user's pins with it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-route-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_LOCAL_DIR = dir; // fork: settings.json is device-local
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
const SETTINGS_FILE = path.join(dir, "settings.json");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_LOCAL_DIR;
	delete process.env.LH_AUTH_FILE;
});

type Route = typeof import("../app/api/custom-providers/[id]/route.ts");
let route: Route;
const ctx = { params: Promise.resolve({ id: "custom" }) };
before(async () => {
	route = await import("../app/api/custom-providers/[id]/route.ts");
});

const BASE = "http://h/v1";
/** A connected endpoint with two discovered models, a pin on each, one typed id. */
const CONNECTED = {
	version: 1,
	customProviders: [{
		id: "custom",
		name: "Custom endpoint",
		baseUrl: BASE,
		authMode: "keyless",
		models: [{ id: "disc-1", context: 131072 }, { id: "disc-2" }],
		overrides: { "disc-1": { context: 200000 }, "disc-2": { maxTokens: 8192 } },
		manualModels: ["m1"],
	}],
};

function seed(record: unknown): void {
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(record, null, "\t"), "utf-8");
}

type Stored = { models?: { id: string }[]; overrides?: unknown; manualModels?: string[] };
function stored(): { customProviders?: Stored[] } {
	return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
}
function entry(): Stored | undefined {
	return stored().customProviders?.[0];
}

function answerWith(status: number, statusText: string, body?: unknown): void {
	globalThis.fetch = (async () => (body === undefined ? new Response("nope", { status, statusText }) : Response.json(body))) as typeof fetch;
}

/** Edits an entry through its own route; a first connect (no entry yet) goes to the list route. */
async function post(payload: unknown): Promise<Response> {
	const init = (etag?: string) => ({
		method: "POST",
		headers: { "content-type": "application/json", origin: "http://localhost", ...(etag ? { "if-match": etag } : {}) },
		body: JSON.stringify({ authMode: payload && typeof payload === "object" && "key" in payload ? "apiKey" : "keyless", ...payload as object }),
	});
	const got = await route.GET(new Request("http://localhost/api/custom-providers/custom"), ctx);
	if (got.status === 404) {
		const list = await import("../app/api/custom-providers/route.ts");
		const body = JSON.parse(String(init().body));
		return list.POST(new Request("http://localhost/api/custom-providers", { ...init(), body: JSON.stringify({ name: "custom", ...body }) }));
	}
	return route.POST(new Request("http://localhost/api/custom-providers/custom", init(got.headers.get("etag")!)), ctx);
}

describe("POST /api/custom-providers/custom — typed ids and a failed probe", () => {
	it("a transient failure keeps the stored models, their metadata, and their pins", async () => {
		seed(CONNECTED);
		answerWith(503, "Service Unavailable");

		const res = await post({ baseUrl: BASE, manualModels: "m1" });
		assert.equal(res.status, 200);

		const cp = entry();
		assert.deepEqual(cp?.models?.map((m) => m.id), ["disc-1", "disc-2", "m1"]);
		assert.deepEqual(cp?.models?.[0], { id: "disc-1", context: 131072 }, "detected metadata survives");
		assert.deepEqual(cp?.overrides, CONNECTED.customProviders[0]!.overrides, "the prune must not fire on a failed probe");
		assert.deepEqual(cp?.manualModels, ["m1"]);
	});

	it("a rejected key fails the connect even when ids are typed", async () => {
		seed(CONNECTED);
		answerWith(401, "Unauthorized");
		const before = stored();

		const res = await post({ baseUrl: BASE, key: "sk-abcdefghijk", manualModels: "m1" });
		assert.equal(res.status, 502);
		assert.deepEqual(stored(), before, "nothing is stored on an auth failure");
	});

	it("a new endpoint with no model list starts from the typed ids alone", async () => {
		seed(CONNECTED);
		answerWith(404, "Not Found");

		const res = await post({ baseUrl: "http://other/v1", manualModels: "y, x" });
		assert.equal(res.status, 200);

		const cp = entry();
		assert.deepEqual(cp?.models?.map((m) => m.id), ["x", "y"], "the previous endpoint's models do not follow the URL");
		assert.equal(cp?.overrides, undefined, "no pin survives a list the old pins do not belong to");
		assert.deepEqual(cp?.manualModels, ["y", "x"], "the typed order is kept as typed");
	});

	it("no model list and no typed ids still refuses, with the hint", async () => {
		answerWith(404, "Not Found");

		const res = await post({ baseUrl: BASE });
		assert.equal(res.status, 502);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /404/);
		assert.match(body.error, /add model IDs manually/);
	});

	it("a working probe merges the typed ids and keeps discovered metadata", async () => {
		seed(CONNECTED);
		answerWith(200, "OK", { data: [{ id: "disc-1", context_length: 65536 }] });

		const res = await post({ baseUrl: BASE, manualModels: "disc-1, m2" });
		assert.equal(res.status, 200);

		const cp = entry();
		assert.deepEqual(cp?.models?.map((m) => m.id), ["disc-1", "m2"]);
		assert.deepEqual(cp?.models?.[0], { id: "disc-1", context: 65536 }, "discovery is not replaced by a bare typed id");
		assert.deepEqual(cp?.overrides, { "disc-1": { context: 200000 } }, "pins follow the ids this connect offers");
		assert.deepEqual(cp?.manualModels, ["disc-1", "m2"]);
	});
});
