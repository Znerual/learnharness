/**
 * Custom OpenAI-compatible endpoints (custom-endpoints wave, owner
 * 2026-10-24). Pinned:
 *  - the pure layer: slug/key rules, URL normalization, the detection
 *    parsers over REAL server listings (vLLM, LM Studio — trimmed copies),
 *    the override merge, the read-side sanitizer;
 *  - the strict section parser and the builtin-collision gate;
 *  - federation: a stored endpoint joins the picker (key optional), its
 *    models carry `custom`, slots may pin them, its key var is writable;
 *  - the engine: on/off thinking (off|high only), the chosen format on
 *    the wire, the endpoint key as the bearer — end to end against a
 *    local fake server;
 *  - detection over a fake fetch (LM Studio enrichment, refusals).
 *
 * LH_DATA_DIR / LH_AUTH_FILE redirect to a fresh tmp dir BEFORE the
 * server modules load (both seams are module-load bound). All keys are
 * throwaway test strings.
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
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_ENDPOINT_TEST_VLLM_KEY;

const core = await import("../src/core/endpoints.ts");
const { parseEndpointsSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const catalog = await import("../src/server/model-catalog.ts");
const keys = await import("../src/server/keys.ts");
const { detectEndpointModels } = await import("../src/server/endpoints.ts");
const { customEndpointModel, piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { getSupportedThinkingLevels, normalizeContext } = await import("@earendil-works/pi-ai");
const { endpointStatusLine, withOverride } = await import("../components/settings/endpoints-group.tsx");
const { classifyKeys } = await import("../components/settings/keys-section.tsx");
const { hasProviderKey } = await import("../components/setup-cta.tsx");
const { thinkingLabel } = await import("../components/thinking-default.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Trimmed copies of the real listings (2026-10-24).
const VLLM_MODELS = {
	object: "list",
	data: [{ id: "qwen3.8-27b", object: "model", owned_by: "vllm", root: "nicosuter/Qwen3.8-27B-AWQ", max_model_len: 65536 }],
};
const LMS_MODELS = {
	data: [
		{ id: "qwen3.8-27b@q6_k_xl", object: "model", owned_by: "organization_owner" },
		{ id: "gpt-oss-20b", object: "model", owned_by: "organization_owner" },
		{ id: "text-embedding-qwen3-embedding-8b@q8_0", object: "model", owned_by: "organization_owner" },
	],
	object: "list",
};
const LMS_V0_MODELS = {
	data: [
		{ id: "qwen3.8-27b@q6_k_xl", type: "vlm", state: "loaded", max_context_length: 262144 },
		{ id: "gpt-oss-20b", type: "llm", state: "not-loaded", max_context_length: 131072 },
		{ id: "text-embedding-qwen3-embedding-8b@q8_0", type: "embeddings", max_context_length: 40960 },
	],
};

function endpoint(overrides: Partial<import("../src/core/endpoints.ts").CustomEndpoint> = {}) {
	return {
		id: "test-vllm",
		name: "Test vLLM",
		baseUrl: "http://127.0.0.1:9/v1",
		thinkingFormat: "qwen-chat-template" as const,
		models: core.parseModelListing(VLLM_MODELS),
		...overrides,
	};
}

describe("slug, key and URL rules", () => {
	it("derives ids from names and validates them", () => {
		assert.equal(core.slugifyEndpointName("AIT Ross (vLLM)"), "ait-ross-vllm");
		assert.equal(core.slugifyEndpointName("  ---  "), "");
		assert.ok(core.isValidEndpointId("ait-ross"));
		assert.ok(!core.isValidEndpointId("-ait"));
		assert.ok(!core.isValidEndpointId("AIT"));
		assert.ok(!core.isValidEndpointId(""));
	});
	it("names the key var after the id and recognizes it", () => {
		assert.equal(core.endpointKeyVar("ait-ross"), "LH_ENDPOINT_AIT_ROSS_KEY");
		assert.ok(core.isEndpointKeyVar("LH_ENDPOINT_AIT_ROSS_KEY"));
		assert.ok(!core.isEndpointKeyVar("OPENAI_API_KEY"));
	});
	it("normalizes base URLs and refuses unusable ones", () => {
		assert.equal(core.normalizeBaseUrl(" http://10.0.0.5:8012/v1/ "), "http://10.0.0.5:8012/v1");
		assert.equal(core.normalizeBaseUrl("ftp://x/v1"), null);
		assert.equal(core.normalizeBaseUrl("http://x/v1?a=1"), null);
		assert.equal(core.normalizeBaseUrl("not a url"), null);
		assert.equal(core.lmStudioV0Url("http://h:1/v1"), "http://h:1/api/v0");
		assert.equal(core.lmStudioV0Url("http://h:1/api"), null);
	});
});

describe("detection parsers", () => {
	it("reads vLLM's max_model_len", () => {
		const [m, ...rest] = core.parseModelListing(VLLM_MODELS) as [import("../src/core/endpoints.ts").EndpointModel];
		assert.equal(rest.length, 0);
		assert.deepEqual(m, { id: "qwen3.8-27b", contextWindow: 65536, maxTokens: 16384, vision: false, reasoning: true });
	});
	it("enriches LM Studio listings and drops embedding models", () => {
		const models = core.parseModelListing(LMS_MODELS, core.parseLmStudioModels(LMS_V0_MODELS));
		assert.deepEqual(
			models.map((m) => [m.id, m.contextWindow, m.vision]),
			[
				["gpt-oss-20b", 131072, false],
				["qwen3.8-27b@q6_k_xl", 262144, true],
			],
		);
	});
	it("falls back without server facts and survives junk", () => {
		const m = core.parseModelListing({ data: [{ id: "llama" }] })[0]!;
		assert.equal(m.contextWindow, core.FALLBACK_CONTEXT_WINDOW);
		assert.equal(m.maxTokens, 16384);
		assert.deepEqual(core.parseModelListing(null), []);
		assert.deepEqual(core.parseModelListing({ data: [{}, 3, { id: "" }] }), []);
		assert.equal(core.parseLmStudioModels({ data: "x" }).size, 0);
	});
	it("re-detection keeps overrides by id and drops vanished models", () => {
		const stored: import("../src/core/endpoints.ts").EndpointModel[] = [
			{ id: "a", contextWindow: 1000, maxTokens: 500, vision: false, reasoning: true, overrides: { vision: true } },
			{ id: "gone", contextWindow: 1000, maxTokens: 500, vision: false, reasoning: true },
		];
		const fresh = [{ id: "a", contextWindow: 4000, maxTokens: 2000, vision: false, reasoning: true }] as const;
		const merged = core.mergeDetectedModels(stored, fresh);
		assert.deepEqual(merged, [{ ...fresh[0], overrides: { vision: true } }]);
		assert.deepEqual(core.effectiveModelValues(merged[0]!), { contextWindow: 4000, maxTokens: 2000, vision: true, reasoning: true });
	});
	it("withOverride sets differing values and clears equal ones", () => {
		const m = { id: "a", contextWindow: 1000, maxTokens: 500, vision: false, reasoning: true };
		const edited = withOverride(m, "contextWindow", 2000);
		assert.deepEqual(edited.overrides, { contextWindow: 2000 });
		assert.equal(withOverride(edited, "contextWindow", 1000).overrides, undefined);
	});
});

describe("the endpoints settings section", () => {
	it("parses a well-formed section strictly", () => {
		const parsed = parseEndpointsSettingsBody({ list: [endpoint({ baseUrl: "http://h:1/v1/" })] });
		assert.ok(parsed.ok);
		assert.equal(parsed.settings.list![0]!.baseUrl, "http://h:1/v1");
		assert.deepEqual(parseEndpointsSettingsBody({}), { ok: true, settings: {} });
	});
	it("rejects bad ids, URLs, formats, duplicates and malformed models", () => {
		const bad = (e: object) => parseEndpointsSettingsBody({ list: [e] });
		assert.ok(!bad(endpoint({ id: "Bad Id" })).ok);
		assert.ok(!bad(endpoint({ baseUrl: "file:///x" })).ok);
		assert.ok(!bad({ ...endpoint(), thinkingFormat: "deepseek" }).ok);
		assert.ok(!bad({ ...endpoint(), models: [{ id: "m", contextWindow: 0, maxTokens: 1, vision: false, reasoning: true }] }).ok);
		assert.ok(!bad({ ...endpoint(), models: [{ id: "m", contextWindow: 1, maxTokens: 1, vision: false, reasoning: true, overrides: { vision: "yes" } }] }).ok);
		assert.ok(!parseEndpointsSettingsBody({ list: [endpoint(), endpoint()] }).ok);
	});
	it("refuses ids that shadow a builtin provider", () => {
		assert.ok(!catalog.validateEndpointsSettings({ list: [endpoint({ id: "openai" })] }).ok);
		assert.ok(catalog.validateEndpointsSettings({ list: [endpoint()] }).ok);
	});
	it("the record sanitizer keeps good endpoints and drops junk", () => {
		const record = sanitizeUserSettings({
			version: 1,
			endpoints: { list: [endpoint(), { id: "x" }, endpoint({ thinkingFormat: "bogus" as never, id: "other" })] },
		});
		assert.deepEqual(
			record?.endpoints?.list?.map((e) => [e.id, e.thinkingFormat]),
			[
				["test-vllm", "qwen-chat-template"],
				["other", "qwen-chat-template"],
			],
		);
	});
});

describe("the pi model a custom endpoint runs as", () => {
	it("offers exactly off|high thinking, the chosen format, zero cost", () => {
		const model = customEndpointModel(endpoint(), endpoint().models[0]!);
		assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);
		assert.equal(model.compat?.thinkingFormat, "qwen-chat-template");
		assert.equal(model.compat?.supportsDeveloperRole, false);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(model.input, ["text"]);
	});
	it("'none' means no thinking control at all; vision overrides reach the input list", () => {
		const e = endpoint({ thinkingFormat: "none" });
		const model = customEndpointModel(e, { ...e.models[0]!, overrides: { vision: true } });
		assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
		assert.deepEqual(model.input, ["text", "image"]);
	});
});

describe("federation through the settings record", () => {
	before(() => writeSettings({ version: 1, endpoints: { list: [endpoint()] } }));

	it("joins the picker with no key, marked custom", () => {
		const { models, providers } = catalog.modelCatalog();
		const row = providers.find((p) => p.id === "test-vllm");
		assert.deepEqual(row, { id: "test-vllm", envVar: "LH_ENDPOINT_TEST_VLLM_KEY", keyPresent: true, custom: true });
		const entry = models.find((m) => m.provider === "test-vllm");
		assert.equal(entry?.id, "qwen3.8-27b");
		assert.equal(entry?.custom, true);
		assert.deepEqual(entry?.supportedLevels, ["off", "high"]);
		assert.equal(catalog.catalogContextLimits().get("test-vllm:qwen3.8-27b"), 65536);
	});
	it("slots may pin its models; the key gate counts it configured", () => {
		assert.ok(catalog.validateModelsSettings({ strong: { model: { provider: "test-vllm", id: "qwen3.8-27b" } } }).ok);
		assert.ok(!catalog.validateModelsSettings({ strong: { model: { provider: "test-vllm", id: "nope" } } }).ok);
		assert.equal(keys.providerKeyPresent("test-vllm"), true);
		assert.deepEqual(keys.customEndpointIds(), ["test-vllm"]);
	});
	it("its key var is writable with paste hygiene only, and stays out of loose key rows", () => {
		assert.ok(keys.isWritableAuthKey("LH_ENDPOINT_TEST_VLLM_KEY"));
		assert.ok(!keys.saveKey("LH_ENDPOINT_TEST_VLLM_KEY", "has space").ok);
		const saved = keys.saveKey("LH_ENDPOINT_TEST_VLLM_KEY", "short");
		assert.ok(saved.ok);
		const statuses = keys.keyStatuses();
		const { providerRows, unknownRows } = classifyKeys(statuses, keys.providerKeyList());
		assert.ok(![...providerRows, ...unknownRows].some((s) => s.id === "LH_ENDPOINT_TEST_VLLM_KEY"));
		assert.equal(endpointStatusLine(endpoint(), statuses.find((s) => s.id === "LH_ENDPOINT_TEST_VLLM_KEY")), "127.0.0.1:9 · 1 model · key");
		keys.deleteKey("LH_ENDPOINT_TEST_VLLM_KEY");
	});
	it("a stored endpoint lifts the zero-keys pill; custom thinking reads on/off", () => {
		assert.equal(hasProviderKey([], [], 1), true);
		assert.equal(hasProviderKey([], [], 0), false);
		assert.equal(thinkingLabel("high", { custom: true }), "on");
		assert.equal(thinkingLabel("high", {}), "high");
		assert.equal(thinkingLabel("off", { custom: true }), "off");
	});
	it("removal from the record removes the provider", () => {
		writeSettings({ version: 1, endpoints: { list: [endpoint({ id: "renamed" })] } });
		assert.equal(piModels().getModel("test-vllm", "qwen3.8-27b"), undefined);
		assert.ok(piModels().getModel("renamed", "qwen3.8-27b"));
		writeSettings({ version: 1, endpoints: { list: [endpoint()] } });
	});
});

describe("the engine against a fake OpenAI-compatible server", () => {
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
				res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "qwen3.8-27b", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		writeSettings({ version: 1, endpoints: { list: [endpoint({ baseUrl: `http://127.0.0.1:${port}/v1` })] } });
	});
	after(() => server.close());

	async function runOnce(level: "off" | "high") {
		const engine = piEngineForSpec({ provider: "test-vllm", id: "qwen3.8-27b", thinkingLevel: level });
		const stream = engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "ping", timestamp: 0 }] }), {});
		const message = await stream.result();
		return { message, request: seen.at(-1)! };
	}

	it("keyless: placeholder bearer, thinking off sent as enable_thinking false", async () => {
		const { message, request } = await runOnce("off");
		assert.equal(message.stopReason, "stop");
		assert.deepEqual(message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text), ["pong"]);
		assert.equal(request.auth, "Bearer no-key");
		assert.deepEqual(request.body?.chat_template_kwargs, { enable_thinking: false, preserve_thinking: true });
		assert.equal(request.body?.model, "qwen3.8-27b");
	});
	it("keyed: the stored key is the bearer, thinking on sent as enable_thinking true", async () => {
		assert.ok(keys.saveKey("LH_ENDPOINT_TEST_VLLM_KEY", "sk-test-123").ok);
		const { request } = await runOnce("high");
		assert.equal(request.auth, "Bearer sk-test-123");
		assert.deepEqual(request.body?.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
		keys.deleteKey("LH_ENDPOINT_TEST_VLLM_KEY");
	});
});

describe("detection over the network seam", () => {
	const fakeFetch =
		(routes: Record<string, { status: number; body?: unknown } | "throw">, seenAuth: (string | undefined)[] = []) =>
		async (url: string | URL | Request, init?: RequestInit) => {
			seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
			const route = routes[String(url)];
			if (!route || route === "throw") throw new TypeError("fetch failed");
			return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
		};

	it("merges LM Studio's rich listing and sends the pasted key", async () => {
		const auth: (string | undefined)[] = [];
		const result = await detectEndpointModels(
			{ baseUrl: "http://lms:1/v1/", apiKey: " k1 " },
			fakeFetch({ "http://lms:1/v1/models": { status: 200, body: LMS_MODELS }, "http://lms:1/api/v0/models": { status: 200, body: LMS_V0_MODELS } }, auth) as typeof fetch,
		);
		assert.ok(result.ok);
		assert.deepEqual(result.models.map((m) => m.id), ["gpt-oss-20b", "qwen3.8-27b@q6_k_xl"]);
		assert.deepEqual(auth, ["Bearer k1", "Bearer k1"]);
	});
	it("stands on the plain listing when the rich one is absent", async () => {
		const result = await detectEndpointModels(
			{ baseUrl: "http://vllm:1/v1" },
			fakeFetch({ "http://vllm:1/v1/models": { status: 200, body: VLLM_MODELS }, "http://vllm:1/api/v0/models": { status: 404 } }) as typeof fetch,
		);
		assert.ok(result.ok);
		assert.equal(result.models[0]!.contextWindow, 65536);
	});
	it("names refusals, unreachable servers, empty listings and bad URLs", async () => {
		const run = (routes: Record<string, { status: number; body?: unknown } | "throw">) =>
			detectEndpointModels({ baseUrl: "http://x:1/v1" }, fakeFetch(routes) as typeof fetch);
		assert.match((await run({ "http://x:1/v1/models": { status: 401 } }) as { error: string }).error, /refused the key/);
		assert.match((await run({ "http://x:1/v1/models": "throw" }) as { error: string }).error, /unreachable/);
		assert.match((await run({ "http://x:1/v1/models": { status: 200, body: { data: [] } } }) as { error: string }).error, /no chat models/);
		assert.ok(!(await detectEndpointModels({ baseUrl: "nope" })).ok);
	});
});
