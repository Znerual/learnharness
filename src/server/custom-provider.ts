/**
 * The custom OpenAI-compatible endpoints: turns each entry of the user's
 * non-secret `customProviders` list (base URL + discovered models) into a
 * pi-ai provider registered in `piModels()` under the entry's id, so its
 * models fill the same slots as any built-in. Keyless local servers work via
 * a placeholder key resolved at request time.
 */

import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviderIds, configureProviderSource, piModels } from "../agent/models.ts";
import { readSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { customBindingMatches, customKeyVar } from "../core/custom-provider-auth.ts";
import { customAuthState, customKeyAuthorized } from "./custom-provider-auth.ts";
import { isEmbeddingModel, isOnOffThinkingFormat, lmStudioV0Url, parseLmStudioModels, type EndpointThinkingFormat, type LmStudioModelInfo } from "../core/endpoints.ts";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	customProviderUsable,
	normalizeBaseUrl,
	type CustomModel,
	type CustomModelOverride,
	type CustomProviderSettings,
} from "../core/settings.ts";


/** Placeholder bearer for keyless endpoints (the OpenAI client needs *a* key). */
const KEYLESS_PLACEHOLDER = "not-needed";

/** Narrow an unknown to a plain object (not null, not an array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored custom endpoints, read fresh. */
export function customProviders(): CustomProviderSettings[] {
	return readSettings()?.customProviders ?? [];
}

/** The stored custom endpoints' ids. */
export function customProviderIds(): Set<string> {
	return new Set(customProviders().map((cp) => cp.id));
}

/** Install the sole custom source: donor settings + explicit authentication,
 * one provider per `customProviders` entry. Publication captures a consistent
 * snapshot; an already-started operation cannot acquire a later endpoint's
 * key. No file configuration source exists. */
export function installCustomProviderSource(readAuth = customAuthState): void {
	let fingerprint: string | undefined;
	let published = new Set<string>();
	configureProviderSource({
		// A removed entry's provider is still ours to retire.
		isCustom: (id) => published.has(id) || customProviderIds().has(id),
		sync(models) {
			const list = customProviders();
			const builtin = new Set(builtinProviderIds());
			const entries = list.filter((cp) => !builtin.has(cp.id)).map((cp) => {
				// Validate the durable nonce/URL/mode before resolving ANY credential.
				// Keyless reads only the nonsecret marker, never a file/env key.
				const auth = readAuth(cp.id, cp.authMode === "apiKey", cp);
				const ready = customProviderUsable(cp) && auth.readable && customBindingMatches(cp, auth.binding) && (cp.authMode === "keyless" || customKeyAuthorized(cp, auth));
				return { cp, auth, ready };
			});
			const next = JSON.stringify(entries); // Private in-memory fingerprint, never a public revision.
			if (next === fingerprint) return;
			const now = new Set<string>();
			for (const { cp, auth, ready } of entries) {
				if (ready && cp.baseUrl) {
					models.setProvider(buildOpenAiCompatibleProvider({ ...cp, baseUrl: cp.baseUrl, models: cp.models ?? [], apiKey: auth.key }));
					now.add(cp.id);
				} else models.deleteProvider(cp.id);
			}
			for (const id of published) if (!now.has(id)) models.deleteProvider(id);
			published = now;
			fingerprint = next;
		},
	});
}

/** Is this custom endpoint registered (configured and authorized)? */
export function customProviderAvailable(id: string): boolean {
	return piModels().getProvider(id) !== undefined;
}

/** Map a discovered model to a pi-ai entry: image→input, reasoning→thinking
 *  levels, context/maxTokens→limits. Resolution ladder (owner, 2026-10-27):
 *  the user's pin wins, then the endpoint's own metadata, then the compiled
 *  default — a local server that says nothing (or says 8k) can be corrected.
 *  baseUrl is stamped per-model. */
function toPiModel(
	model: CustomModel,
	providerId: string,
	baseUrl: string,
	overrides: Record<string, CustomModelOverride>,
	thinkingFormat: EndpointThinkingFormat,
): Model<Api> {
	const pin = overrides[model.id];
	// Pin wins; else detected from the endpoint's metadata (see
	// detectReasoning). "none" never sends thinking parameters.
	const reasoning = (pin?.reasoning ?? Boolean(model.reasoning)) && thinkingFormat !== "none";
	const onOff = reasoning && isOnOffThinkingFormat(thinkingFormat);
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		// "openai": true makes pi-ai offer the standard levels and send
		// reasoning_effort on the wire; no thinkingLevelMap → the default
		// off/minimal/low/medium/high set. The Qwen formats are ON/OFF only
		// (custom-endpoints wave, owner 2026-10-24): the level map leaves
		// exactly off + high, and the format decides what "on" sends.
		reasoning,
		...(onOff ? { thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" } } : {}),
		input: model.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: pin?.context ?? model.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
		maxTokens: pin?.maxTokens ?? model.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
		type: "chat",
		// Local servers (vLLM, LM Studio) reject the developer role and the
		// store flag; the Qwen formats ride pi-ai's thinkingFormat.
		...(thinkingFormat !== "openai" ? {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsStore: false,
				...(thinkingFormat !== "none" ? { thinkingFormat } : {}),
			},
		} : {}),
	};
}

/** Build an OpenAI-compatible provider from parts. baseUrl must be normalized. */
export function buildOpenAiCompatibleProvider(input: {
	id: string;
	name: string;
	thinkingFormat?: EndpointThinkingFormat;
	baseUrl: string;
	models: readonly CustomModel[];
	/** User pins by model id (see CustomModelOverride) — absent = none. */
	overrides?: Record<string, CustomModelOverride>;
	/** Already resolved for this publication; absent means explicit keyless. */
	apiKey?: string;
}): Provider<Api> {
	const overrides = input.overrides ?? {};
	return createProvider<Api>({
		id: input.id,
		name: input.name,
		baseUrl: input.baseUrl,
		auth: { apiKey: {
			name: `${input.name} API key`,
			resolve: async () => ({ auth: { apiKey: input.apiKey ?? KEYLESS_PLACEHOLDER }, source: input.apiKey ? customKeyVar(input.id) : "keyless" }),
		} },
		models: input.models.map((m) => toPiModel(m, input.id, input.baseUrl, overrides, input.thinkingFormat ?? "openai")),
		api: openAICompletionsApi(),
	});
}

/** Re-sync the provider into piModels() (idempotent): usable → rebuild;
 *  not usable → remove. Never throws. */
export function syncCustomProvider(): void {
	piModels();
}

/** Outcome of a model-discovery probe. `status` is the endpoint's HTTP status
 *  when it answered at all, so callers can tell a rejected key from a missing
 *  model list. */
export type DiscoverResult =
	| { ok: true; models: CustomModel[] }
	| { ok: false; error: string; status?: number; fatal?: boolean };

/** Probe GET {baseUrl}/models for model ids. Scheme validated (http/https
 *  only); keyless endpoints answer without a bearer. Non-2xx or unparseable
 *  body → honest error, never a silent empty list. */
export async function discoverModels(baseUrl: string, apiKey?: string, options: { assumeReasoning?: boolean } = {}): Promise<DiscoverResult> {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) return { ok: false, error: "Base URL must be a valid http(s) URL" };
	const key = apiKey?.trim();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(`${base}/models`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: controller.signal,
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			return { ok: false, error: "Discovery redirects are not allowed", fatal: true };
		}
		if (!res.ok) { await res.body?.cancel(); return { ok: false, error: `Endpoint returned HTTP ${res.status}`, status: res.status }; }
		const body = await readBoundedJson(res, 8 * 1024 * 1024);
		const lmStudio = await lmStudioIndex(base, key);
		const list = extractModels(body, lmStudio, options.assumeReasoning === true);
		if (list === null) return { ok: false, error: "Endpoint response was not a model list" };
		return { ok: true, models: list };
	} catch (err) {
		return { ok: false, error: err instanceof CustomBodyLimitError ? err.message : controller.signal.aborted ? "Endpoint timed out" : "Discovery request failed", fatal: err instanceof CustomBodyLimitError };
	} finally {
		clearTimeout(timer);
	}
}

/** LM Studio's richer listing (GET <root>/api/v0/models, custom-endpoints
 *  wave): context lengths, vision ("vlm") and embedding models, which its
 *  OpenAI-style /models omits. Best-effort — any failure is an empty index. */
async function lmStudioIndex(base: string, key: string | undefined): Promise<Map<string, LmStudioModelInfo>> {
	const url = lmStudioV0Url(base);
	if (!url) return new Map();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch(`${url}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: controller.signal, redirect: "manual" });
		if (!res.ok) { await res.body?.cancel(); return new Map(); }
		return parseLmStudioModels(await readBoundedJson(res, 8 * 1024 * 1024));
	} catch {
		return new Map();
	} finally {
		clearTimeout(timer);
	}
}

/** The connect's model list: what the endpoint advertises, plus every typed id
 *  it does not advertise (at default limits, so the pins can correct them).
 *  Discovered metadata always wins over a typed id of the same name. */
export function mergeManualModels(discovered: readonly CustomModel[], manualIds: readonly string[]): CustomModel[] {
	const byId = new Map(discovered.map((m) => [m.id, m]));
	for (const id of manualIds) if (!byId.has(id)) byId.set(id, { id });
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Model rows from a list response ({data:[…]} | {models:[…]} | bare array),
 *  or null if unrecognized. */
function modelRows(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (isRecord(body)) {
		if (Array.isArray(body.data)) return body.data;
		if (Array.isArray(body.models)) return body.models;
	}
	return null;
}

/** Does a /models row advertise image input? Scans the common modality/
 *  capability fields; absent or unrecognized → false (text-only). */
function detectImage(row: Record<string, unknown>): boolean {
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const candidates = [
		architecture?.input_modalities,
		row.input_modalities,
		row.modalities,
		row.supported_modalities,
		row.capabilities,
	];
	for (const c of candidates) {
		if (Array.isArray(c) && c.some((v) => typeof v === "string" && /image|vision/i.test(v))) return true;
	}
	return false;
}

/** Does a /models row advertise reasoning? Metadata only — no name guessing,
 *  because a false positive sends reasoning_effort an endpoint will reject.
 *  Trusted signals: an explicit boolean (reasoning / supports_reasoning /
 *  thinking) or a reasoning token in the capability/parameter lists servers
 *  publish (vLLM + OpenRouter's supported_parameters, capabilities, tags).
 *  Absent or unrecognized → false (thinking stays "off"). */
function detectReasoning(row: Record<string, unknown>): boolean {
	for (const key of ["reasoning", "supports_reasoning", "thinking"] as const) {
		if (row[key] === true) return true;
	}
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const candidates = [row.supported_parameters, row.capabilities, row.tags, architecture?.output_modalities];
	return candidates.some(
		(list) =>
			Array.isArray(list) &&
			list.some((v) => typeof v === "string" && (/reasoning/i.test(v) || v.toLowerCase() === "thinking")),
	);
}

/** First positive integer among `keys` on a row (endpoints name limits
 *  inconsistently). */
function firstPositive(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}

// Field names seen in the wild for each limit (first present wins).
// max_model_len is vLLM's — also nested under `openai` when an Open WebUI
// gateway proxies vLLM (custom-endpoints wave).
const CONTEXT_KEYS = ["max_input_tokens", "context_length", "context_window", "max_context", "n_ctx", "max_seq_len", "max_model_len", "max_position_embeddings"] as const;
const MAX_TOKEN_KEYS = ["max_output_tokens"] as const;

/** Pull models from a list response (objects with `id` or bare strings), each
 *  with detected image + token limits; LM Studio's index adds context, vision
 *  and drops embedding models. `assumeReasoning` marks every model as
 *  reasoning (the Qwen thinking formats: the format decides what "on"
 *  sends). Null if the shape is unrecognized. */
function extractModels(body: unknown, lmStudio: Map<string, LmStudioModelInfo> = new Map(), assumeReasoning = false): CustomModel[] | null {
	const rows = modelRows(body);
	if (rows === null) return null;
	if (rows.length > 10_000) throw new CustomBodyLimitError("Model list exceeds 10000 entries");
	const byId = new Map<string, CustomModel>();
	for (const row of rows) {
		const id = typeof row === "string" ? row : isRecord(row) && typeof row.id === "string" ? row.id : "";
		if (!id.trim()) continue;
		const info = lmStudio.get(id);
		if (isEmbeddingModel(id, info)) continue;
		const model: CustomModel = { id };
		if (isRecord(row)) {
			// An Open WebUI gateway nests the proxied server's own row under `openai`.
			const proxied = isRecord(row.openai) ? row.openai : undefined;
			if (detectImage(row)) model.image = true;
			if (detectReasoning(row)) model.reasoning = true;
			const context = firstPositive(row, CONTEXT_KEYS) ?? (proxied ? firstPositive(proxied, CONTEXT_KEYS) : undefined);
			if (context) model.context = context;
			const maxTokens = firstPositive(row, MAX_TOKEN_KEYS) ?? (proxied ? firstPositive(proxied, MAX_TOKEN_KEYS) : undefined);
			if (maxTokens) model.maxTokens = maxTokens;
		}
		if (info?.type === "vlm") model.image = true;
		if (!model.context && info?.maxContextLength) model.context = info.maxContextLength;
		if (assumeReasoning) model.reasoning = true;
		byId.set(id, model);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
