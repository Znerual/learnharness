/**
 * Custom endpoints as a LIST (custom-endpoints wave, owner 2026-10-24,
 * rebuilt on upstream's custom provider 2026-10-30). Upstream's own guarantees
 * (binding, consent, ETags, limits) are pinned per entry by the
 * custom-provider-* tests; this file pins what the list adds:
 *  - the id / key / binding naming per entry ("custom" keeps upstream's);
 *  - the thinking formats on the pi model (ON/OFF for Qwen, none, openai);
 *  - discovery's LM Studio / vLLM / Open WebUI facts;
 *  - adding an endpoint (id from the name, builtin and duplicate refusals);
 *  - the one-time migration of the fork's `endpoints` section and of
 *    upstream's single `customProvider`, with keys bound to their URLs;
 *  - federation of a migrated endpoint and its key on the wire, end to end
 *    against a local fake server.
 *
 * LH_DATA_DIR / LH_LOCAL_DIR / LH_AUTH_FILE redirect to a fresh tmp dir
 * BEFORE the server modules load (the seams are module-load bound). All keys
 * are throwaway test strings.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-endpoints-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_LOCAL_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_ENDPOINT_TEST_VLLM_KEY;
const SETTINGS_FILE = path.join(TMP, "settings.json");
const AUTH_FILE = path.join(TMP, "auth.json");

const core = await import("../src/core/endpoints.ts");
const { customBindingVar, customKeyVar, isCustomAuthVar } = await import("../src/core/custom-provider-auth.ts");
const { buildOpenAiCompatibleProvider, customProviderAvailable, discoverModels, syncCustomProvider } = await import("../src/server/custom-provider.ts");
const { migrateCustomEndpoints } = await import("../src/server/custom-provider-migration.ts");
const catalog = await import("../src/server/model-catalog.ts");
const keys = await import("../src/server/keys.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { getSupportedThinkingLevels, normalizeContext } = await import("@earendil-works/pi-ai");
const { thinkingLabel } = await import("../components/thinking-default.ts");
const route = await import("../app/api/custom-providers/route.ts");

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, "\t"));

/** The fork's legacy `endpoints` entry, as the 2026-10-24 app stored it. */
function legacyEndpoint(baseUrl = "http://127.0.0.1:9/v1") {
	return {
		id: "test-vllm",
		name: "Test vLLM",
		baseUrl,
		thinkingFormat: "qwen-chat-template",
		models: [
			{ id: "qwen3.8-27b", contextWindow: 65536, maxTokens: 16384, vision: false, reasoning: true },
			{ id: "gemma-4", contextWindow: 262144, maxTokens: 16384, vision: false, reasoning: true, overrides: { vision: true, contextWindow: 131072 } },
		],
	};
}

describe("naming per entry", () => {
	it("derives ids from names; 'custom' keeps upstream's key and binding", () => {
		assert.equal(core.slugifyEndpointName("Lab LM Studio"), "lab-lm-studio");
		assert.ok(core.isValidEndpointId("lab-gpu"));
		assert.ok(!core.isValidEndpointId("-x"));
		assert.equal(customKeyVar("lab-gpu"), "LH_ENDPOINT_LAB_GPU_KEY");
		assert.equal(customKeyVar("custom"), "CUSTOM_OPENAI_API_KEY");
		assert.equal(customBindingVar("custom"), "__learnharness_custom_provider_binding");
		assert.equal(customBindingVar("lab-gpu"), "__learnharness_custom_provider_binding:lab-gpu");
	});
	it("every entry's key and binding stay out of the generic key API", () => {
		for (const name of ["LH_ENDPOINT_LAB_GPU_KEY", "CUSTOM_OPENAI_API_KEY", "__learnharness_custom_provider_binding:x"]) {
			assert.ok(isCustomAuthVar(name), name);
			assert.ok(!keys.isWritableAuthKey(name), name);
			assert.equal(keys.saveKey(name, "sk-x").ok, false);
		}
	});
});

describe("the thinking format on the pi model", () => {
	const build = (thinkingFormat?: "openai" | "qwen-chat-template" | "none") =>
		buildOpenAiCompatibleProvider({ id: "t", name: "T", thinkingFormat, baseUrl: "http://h/v1", models: [{ id: "m", reasoning: true }] }).getModels()[0]!;
	it("the Qwen formats are ON/OFF, sent as pi's thinkingFormat, without the developer role", () => {
		const model = build("qwen-chat-template");
		assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);
		const compat = model.compat as { thinkingFormat?: string; supportsDeveloperRole?: boolean } | undefined;
		assert.equal(compat?.thinkingFormat, "qwen-chat-template");
		assert.equal(compat?.supportsDeveloperRole, false);
		assert.equal(model.provider, "t");
	});
	it("'none' offers no thinking; 'openai' (and absent) keeps upstream's every effort level", () => {
		assert.deepEqual(getSupportedThinkingLevels(build("none")), ["off"]);
		assert.equal(build("openai").compat, undefined);
		assert.ok(getSupportedThinkingLevels(build()).includes("medium"));
	});
	it("an ON/OFF model reads 'on'", () => {
		assert.equal(thinkingLabel("high", { onOffThinking: true }), "on");
		assert.equal(thinkingLabel("high", {}), "high");
	});
});

describe("discovery's server facts", () => {
	const answer = (routes: Record<string, unknown>) => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			const body = routes[String(url)];
			return body === undefined ? new Response("no", { status: 404 }) : Response.json(body);
		}) as typeof fetch;
	};
	it("LM Studio's rich listing adds context and vision, and drops embedding models", async () => {
		answer({
			"http://lms:1/v1/models": { data: [{ id: "qwen@q6" }, { id: "gpt-oss-20b" }, { id: "text-embedding-qwen3@q8" }] },
			"http://lms:1/api/v0/models": { data: [
				{ id: "qwen@q6", type: "vlm", max_context_length: 262144 },
				{ id: "gpt-oss-20b", type: "llm", max_context_length: 131072 },
				{ id: "text-embedding-qwen3@q8", type: "embeddings" },
			] },
		});
		const found = await discoverModels("http://lms:1/v1");
		assert.ok(found.ok);
		assert.deepEqual(found.models, [{ id: "gpt-oss-20b", context: 131072 }, { id: "qwen@q6", image: true, context: 262144 }]);
	});
	it("vLLM's max_model_len, also nested under Open WebUI's `openai`; Qwen formats assume reasoning", async () => {
		answer({ "http://owui/api/models": { data: [{ id: "a", max_model_len: 65536 }, { id: "b", openai: { max_model_len: 32768 } }] } });
		const found = await discoverModels("http://owui/api", undefined, { assumeReasoning: true });
		assert.ok(found.ok);
		assert.deepEqual(found.models, [{ id: "a", context: 65536, reasoning: true }, { id: "b", context: 32768, reasoning: true }]);
	});
});

describe("adding an endpoint", () => {
	const create = (body: object) => route.POST(new Request("http://localhost/api/custom-providers", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "http://localhost" },
		body: JSON.stringify({ authMode: "keyless", baseUrl: "http://lms:1/v1", ...body }),
	}));
	before(() => {
		writeJson(SETTINGS_FILE, { version: 1 });
		globalThis.fetch = (async () => Response.json({ data: [{ id: "m" }] })) as typeof fetch;
	});
	it("takes its id from the name and joins the list after the others", async () => {
		assert.equal((await create({ name: "First Box" })).status, 200);
		assert.equal((await create({ name: "Second Box", thinkingFormat: "qwen" })).status, 200);
		const list = (await route.GET().json()) as { providers: { id: string; name: string; thinkingFormat: string; revision: string }[] };
		assert.deepEqual(list.providers.map((p) => [p.id, p.name, p.thinkingFormat]), [["first-box", "First Box", "openai"], ["second-box", "Second Box", "qwen"]]);
		assert.ok(list.providers.every((p) => p.revision.startsWith("\"")));
	});
	it("refuses a duplicate, a builtin provider's id, a missing name and a nameless slug", async () => {
		assert.equal((await create({ name: "first box" })).status, 409);
		assert.equal((await create({ name: "OpenAI" })).status, 400);
		assert.equal((await create({})).status, 400);
		assert.equal((await create({ name: "!!" })).status, 400);
	});
});

describe("the migration", () => {
	let server: http.Server;
	const seen: { auth?: string; body?: Record<string, unknown> }[] = [];

	before(async () => {
		server = http.createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (delta: object, finish: string | null) =>
					`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "qwen3.8-27b", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				res.write(chunk({ role: "assistant", content: "pong" }, null));
				res.write(chunk({}, "stop"));
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		globalThis.fetch = realFetch;
		writeJson(SETTINGS_FILE, {
			version: 1,
			models: { strong: { model: { provider: "test-vllm", id: "qwen3.8-27b" } } },
			endpoints: { list: [legacyEndpoint(`http://127.0.0.1:${port}/v1`), { ...legacyEndpoint("http://other:1/v1"), id: "keyless-box", name: "Keyless" }] },
			customProvider: { baseUrl: "http://single:1/v1", authMode: "keyless", credentialBindingId: "a".repeat(32), models: [{ id: "s" }] },
		});
		writeJson(AUTH_FILE, { LH_ENDPOINT_TEST_VLLM_KEY: "sk-test-123", OPENAI_API_KEY: "sk-keep" });
		migrateCustomEndpoints();
		syncCustomProvider();
	});
	after(() => server.close());

	it("moves both legacy sections into customProviders and leaves everything else", () => {
		const record = readJson(SETTINGS_FILE) as { endpoints?: unknown; customProvider?: unknown; models?: unknown; customProviders: { id: string; name: string; thinkingFormat?: string; authMode: string; models: unknown[]; overrides?: unknown }[] };
		assert.equal(record.endpoints, undefined);
		assert.equal(record.customProvider, undefined);
		assert.deepEqual(record.models, { strong: { model: { provider: "test-vllm", id: "qwen3.8-27b" } } });
		assert.deepEqual(record.customProviders.map((cp) => [cp.id, cp.name, cp.thinkingFormat, cp.authMode]), [
			["custom", "Custom endpoint", undefined, "keyless"],
			["test-vllm", "Test vLLM", "qwen-chat-template", "apiKey"],
			["keyless-box", "Keyless", "qwen-chat-template", "keyless"],
		]);
		const vllm = record.customProviders[1]!;
		assert.deepEqual(vllm.models, [
			{ id: "gemma-4", image: true, reasoning: true, context: 262144, maxTokens: 16384 },
			{ id: "qwen3.8-27b", reasoning: true, context: 65536, maxTokens: 16384 },
		]);
		assert.deepEqual(vllm.overrides, { "gemma-4": { context: 131072 } });
	});
	it("binds each legacy key to its current URL; other keys and upstream's binding are untouched", () => {
		const auth = readJson(AUTH_FILE);
		const binding = JSON.parse(auth[customBindingVar("test-vllm")] as string) as { authMode: string; baseUrl: string; fileKeyBaseUrl?: string };
		const record = readJson(SETTINGS_FILE) as { customProviders: { id: string; baseUrl: string }[] };
		const url = record.customProviders.find((cp) => cp.id === "test-vllm")!.baseUrl;
		assert.deepEqual([binding.authMode, binding.baseUrl, binding.fileKeyBaseUrl], ["apiKey", url, url]);
		assert.equal(auth.LH_ENDPOINT_TEST_VLLM_KEY, "sk-test-123");
		assert.equal(auth.OPENAI_API_KEY, "sk-keep");
		assert.equal(JSON.parse(auth[customBindingVar("keyless-box")] as string).authMode, "keyless");
		assert.equal(auth[customBindingVar("custom")], undefined);
	});
	it("runs once: a second run changes nothing", () => {
		const before = [fs.readFileSync(SETTINGS_FILE, "utf8"), fs.readFileSync(AUTH_FILE, "utf8")];
		migrateCustomEndpoints();
		assert.deepEqual([fs.readFileSync(SETTINGS_FILE, "utf8"), fs.readFileSync(AUTH_FILE, "utf8")], before);
	});
	it("a migrated endpoint federates with its slot intact, unpriced and ON/OFF", () => {
		assert.ok(customProviderAvailable("test-vllm"));
		const { models, providers } = catalog.modelCatalog();
		assert.deepEqual(providers.find((p) => p.id === "test-vllm"), { id: "test-vllm", envVar: "LH_ENDPOINT_TEST_VLLM_KEY", keyPresent: true, custom: true });
		const entry = models.find((m) => m.provider === "test-vllm" && m.id === "qwen3.8-27b");
		assert.deepEqual([entry?.custom, entry?.onOffThinking, entry?.cost], [true, true, null]);
		assert.equal(catalog.catalogContextLimits().get("test-vllm:gemma-4"), 131072);
		assert.equal(keys.providerKeyPresent("test-vllm"), true);
	});
	it("its key is the bearer, and thinking rides the Qwen chat template", async () => {
		const engine = piEngineForSpec({ provider: "test-vllm", id: "qwen3.8-27b", thinkingLevel: "high" });
		const message = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "ping", timestamp: 0 }] }), {}).result();
		assert.equal(message.stopReason, "stop");
		const request = seen.at(-1)!;
		assert.equal(request.auth, "Bearer sk-test-123");
		assert.deepEqual(request.body?.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
	});
});
