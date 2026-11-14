/**
 * Startup re-detect (owner, 2026-11-14): redetectCustomProviders() discovers
 * every endpoint's models again once per server start and replaces them like
 * Save does. A failed discovery keeps what is stored, and a record that
 * changed while discovery ran is never overwritten.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-redetect-"));
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

type Http = typeof import("../src/server/custom-provider-http.ts");
let http: Http;
before(async () => {
	http = await import("../src/server/custom-provider-http.ts");
});

/** A keyless endpoint carrying the old fork fallback (16384) on two models, a pin on each, one typed id. */
const STORED = {
	version: 1,
	customProviders: [{
		id: "custom",
		name: "Custom endpoint",
		baseUrl: "http://h/v1",
		authMode: "keyless",
		models: [{ id: "flash", context: 262144, maxTokens: 16384 }, { id: "gone", context: 131072, maxTokens: 16384 }],
		overrides: { flash: { reasoning: true }, gone: { context: 65536 } },
		manualModels: ["typed"],
	}],
};

type Stored = { models?: { id: string; context?: number; maxTokens?: number }[]; overrides?: Record<string, unknown>; manualModels?: string[]; name?: string };
const seed = (record: unknown) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(record, null, "\t"), "utf-8");
const entry = (): Stored | undefined => JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")).customProviders?.[0];

describe("redetectCustomProviders", () => {
	it("replaces the stored models like Save: fresh facts, typed ids kept, pins of vanished models dropped", async () => {
		seed(STORED);
		globalThis.fetch = (async () => Response.json({ data: [{ id: "flash", max_model_len: 262144 }, { id: "new-one" }] })) as typeof fetch;
		await http.redetectCustomProviders();
		const cp = entry()!;
		assert.deepEqual(cp.models!.map((m) => m.id), ["flash", "new-one", "typed"]);
		const flash = cp.models!.find((m) => m.id === "flash")!;
		assert.equal(flash.context, 262144);
		assert.equal(flash.maxTokens, undefined, "the old 16384 fallback is gone; the new fallback applies");
		assert.deepEqual(cp.overrides, { flash: { reasoning: true } });
		assert.deepEqual(cp.manualModels, ["typed"]);
	});

	it("keeps the stored models when discovery fails", async () => {
		seed(STORED);
		globalThis.fetch = (async () => new Response("down", { status: 502 })) as typeof fetch;
		await http.redetectCustomProviders();
		assert.deepEqual(entry(), STORED.customProviders[0]);
	});

	it("never overwrites a record that changed while discovery ran", async () => {
		seed(STORED);
		globalThis.fetch = (async () => {
			seed({ ...STORED, customProviders: [{ ...STORED.customProviders[0], name: "Renamed meanwhile" }] });
			return Response.json({ data: [{ id: "flash" }] });
		}) as typeof fetch;
		await http.redetectCustomProviders();
		const cp = entry()!;
		assert.equal(cp.name, "Renamed meanwhile");
		assert.deepEqual(cp.models, STORED.customProviders[0]!.models);
	});

	it("skips an API-key endpoint without an authorized key", async () => {
		seed({ ...STORED, customProviders: [{ ...STORED.customProviders[0], authMode: "apiKey" }] });
		let called = false;
		globalThis.fetch = (async () => { called = true; return Response.json({ data: [] }); }) as typeof fetch;
		await http.redetectCustomProviders();
		assert.equal(called, false);
		assert.deepEqual(entry()!.models, STORED.customProviders[0]!.models);
	});
});
