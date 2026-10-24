/**
 * CUSTOM ENDPOINTS (custom-endpoints wave, owner 2026-10-24): user-added
 * OpenAI-compatible servers (vLLM, LM Studio, Ollama, llama.cpp, …) that
 * join pi-ai's builtin providers as first-class model sources.
 *
 * PURE, browser-safe — no fs, no env, no network. This module owns:
 *  - the stored shape (the `endpoints` settings section — non-secret:
 *    name, base URL, thinking format, the detected model list with
 *    per-model overrides),
 *  - the slug + key-variable rules (the key itself lives in auth.json
 *    under LH_ENDPOINT_<ID>_KEY — secrets never enter settings.json),
 *  - the detection parsers over the servers' own model listings (the
 *    network half lives in src/server/endpoints.ts),
 *  - the effective view (detected values with overrides applied).
 *
 * Owner rulings: generic endpoints, not AIT presets; auto-detect +
 * per-model override; the detected list is PERSISTED (slots stay valid
 * while a backend is down); the key is OPTIONAL (keyless local servers
 * count as configured); thinking is ON/OFF only, sent in the endpoint's
 * chosen format (default qwen-chat-template), stored as pi's off/high.
 */

/** How thinking on/off reaches the server (pi-ai's openai-completions
 *  thinkingFormat, narrowed to the on/off-capable ones), or "none" —
 *  never send thinking params; the model runs its own default. */
export const ENDPOINT_THINKING_FORMATS = ["qwen-chat-template", "qwen", "openai", "none"] as const;
export type EndpointThinkingFormat = (typeof ENDPOINT_THINKING_FORMATS)[number];
export const DEFAULT_ENDPOINT_THINKING_FORMAT: EndpointThinkingFormat = "qwen-chat-template";

/** One-line labels for the settings form's thinking-format select. */
export const ENDPOINT_THINKING_FORMAT_LABEL: Record<EndpointThinkingFormat, string> = {
	"qwen-chat-template": "chat_template_kwargs.enable_thinking (Qwen on vLLM / LM Studio)",
	qwen: "top-level enable_thinking",
	openai: "reasoning_effort",
	none: "never send — model default",
};

/** The model values detection fills and the user may override. */
export interface EndpointModelValues {
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	reasoning: boolean;
}

/** One stored model: the DETECTED values plus optional user overrides
 *  (a re-detect replaces the detected half and keeps the overrides). */
export interface EndpointModel extends EndpointModelValues {
	id: string;
	overrides?: Partial<EndpointModelValues>;
}

/** One stored endpoint. `id` doubles as the pi-ai provider id. */
export interface CustomEndpoint {
	id: string;
	name: string;
	baseUrl: string;
	thinkingFormat: EndpointThinkingFormat;
	models: EndpointModel[];
}

/** The `endpoints` settings section. */
export interface EndpointsSettings {
	list?: CustomEndpoint[];
}

// ─── slug + key rules ────────────────────────────────────────────────────────

const ENDPOINT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A valid endpoint id: lowercase letters, digits, inner hyphens, ≤ 40. */
export function isValidEndpointId(id: string): boolean {
	return ENDPOINT_ID_RE.test(id);
}

/** The id a fresh endpoint derives from its name ("AIT Ross" → "ait-ross"). */
export function slugifyEndpointName(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

const KEY_VAR_PREFIX = "LH_ENDPOINT_";
const KEY_VAR_SUFFIX = "_KEY";

/** The auth.json / env var holding an endpoint's key ("ait-ross" →
 *  LH_ENDPOINT_AIT_ROSS_KEY). */
export function endpointKeyVar(id: string): string {
	return `${KEY_VAR_PREFIX}${id.toUpperCase().replace(/-/g, "_")}${KEY_VAR_SUFFIX}`;
}

/** Is this var name an endpoint key (any endpoint, stored or not)? */
export function isEndpointKeyVar(name: string): boolean {
	return /^LH_ENDPOINT_[A-Z0-9_]+_KEY$/.test(name);
}

/** A base URL the server can call: http(s), no query/fragment, trailing
 *  slashes trimmed. Returns null when unusable. */
export function normalizeBaseUrl(raw: string): string | null {
	const trimmed = raw.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.search || url.hash) return null;
	return trimmed.replace(/\/+$/, "");
}

// ─── effective view ──────────────────────────────────────────────────────────

/** The values a model actually runs with: detected, overrides on top. */
export function effectiveModelValues(model: EndpointModel): EndpointModelValues {
	return {
		contextWindow: model.overrides?.contextWindow ?? model.contextWindow,
		maxTokens: model.overrides?.maxTokens ?? model.maxTokens,
		vision: model.overrides?.vision ?? model.vision,
		reasoning: model.overrides?.reasoning ?? model.reasoning,
	};
}

/** Merge a fresh detection into a stored list: the detected half comes
 *  from `detected`, overrides carry over by model id, vanished models
 *  drop. */
export function mergeDetectedModels(stored: readonly EndpointModel[], detected: readonly EndpointModel[]): EndpointModel[] {
	const overridesById = new Map(stored.map((m) => [m.id, m.overrides]));
	return detected.map((m) => {
		const overrides = overridesById.get(m.id);
		return overrides && Object.keys(overrides).length ? { ...m, overrides } : { ...m };
	});
}

// ─── detection parsers ───────────────────────────────────────────────────────

/** Context window when the server reports none. */
export const FALLBACK_CONTEXT_WINDOW = 32_768;
/** Output ceiling cap — pi-ai clamps further to the remaining context. */
const MAX_TOKENS_CAP = 16_384;

/** The default output ceiling for a context window. */
export function defaultMaxTokens(contextWindow: number): number {
	return Math.max(1024, Math.min(MAX_TOKENS_CAP, Math.floor(contextWindow / 2)));
}

/** LM Studio's richer listing (GET <root>/api/v0/models) — per id. */
export interface LmStudioModelInfo {
	type?: string;
	maxContextLength?: number;
}

const positiveInt = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** Parse LM Studio's /api/v0/models body into an id → info index.
 *  Anything malformed yields an empty index (the plain listing still
 *  stands on its own). */
export function parseLmStudioModels(body: unknown): Map<string, LmStudioModelInfo> {
	const index = new Map<string, LmStudioModelInfo>();
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return index;
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string") continue;
		index.set(e.id, {
			type: typeof e.type === "string" ? e.type : undefined,
			maxContextLength: positiveInt(e.max_context_length),
		});
	}
	return index;
}

/** Embedding models cannot answer — never listed. */
function isEmbeddingModel(id: string, info: LmStudioModelInfo | undefined): boolean {
	if (info?.type === "embeddings") return true;
	return /embed/i.test(id);
}

/**
 * Parse the OpenAI-style GET <baseUrl>/models body (+ LM Studio's index
 * when the server has one) into detected models, sorted by id.
 * Context: vLLM's `max_model_len`, else LM Studio's max_context_length,
 * else FALLBACK_CONTEXT_WINDOW. Vision: LM Studio `type: "vlm"` only
 * (nothing else reports it — the user overrides). Reasoning: assumed on
 * (the thinking format decides what is sent; a model whose template has
 * no thinking switch ignores it).
 */
export function parseModelListing(body: unknown, lmStudio: Map<string, LmStudioModelInfo> = new Map()): EndpointModel[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	const seen = new Set<string>();
	const out: EndpointModel[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || !e.id.trim() || seen.has(e.id)) continue;
		const info = lmStudio.get(e.id);
		if (isEmbeddingModel(e.id, info)) continue;
		seen.add(e.id);
		const contextWindow = positiveInt(e.max_model_len) ?? info?.maxContextLength ?? FALLBACK_CONTEXT_WINDOW;
		out.push({
			id: e.id,
			contextWindow,
			maxTokens: defaultMaxTokens(contextWindow),
			vision: info?.type === "vlm",
			reasoning: true,
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** LM Studio's /api/v0 root for an OpenAI-style base URL ("…/v1" →
 *  "…/api/v0"); null when the URL does not end in /v1. */
export function lmStudioV0Url(baseUrl: string): string | null {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? `${trimmed.slice(0, -3)}/api/v0` : null;
}

// ─── sanitizer (read side — lenient, never throws) ───────────────────────────

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function sanitizeOverrides(raw: unknown): Partial<EndpointModelValues> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: Partial<EndpointModelValues> = {};
	const contextWindow = positiveInt(r.contextWindow);
	if (contextWindow !== undefined) out.contextWindow = contextWindow;
	const maxTokens = positiveInt(r.maxTokens);
	if (maxTokens !== undefined) out.maxTokens = maxTokens;
	const vision = bool(r.vision);
	if (vision !== undefined) out.vision = vision;
	const reasoning = bool(r.reasoning);
	if (reasoning !== undefined) out.reasoning = reasoning;
	return Object.keys(out).length ? out : undefined;
}

function sanitizeModel(raw: unknown): EndpointModel | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id.trim()) return undefined;
	const contextWindow = positiveInt(r.contextWindow) ?? FALLBACK_CONTEXT_WINDOW;
	const model: EndpointModel = {
		id: r.id,
		contextWindow,
		maxTokens: positiveInt(r.maxTokens) ?? defaultMaxTokens(contextWindow),
		vision: bool(r.vision) ?? false,
		reasoning: bool(r.reasoning) ?? true,
	};
	const overrides = sanitizeOverrides(r.overrides);
	if (overrides) model.overrides = overrides;
	return model;
}

function sanitizeEndpoint(raw: unknown): CustomEndpoint | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !isValidEndpointId(r.id)) return undefined;
	const baseUrl = typeof r.baseUrl === "string" ? normalizeBaseUrl(r.baseUrl) : null;
	if (!baseUrl) return undefined;
	const thinkingFormat = (ENDPOINT_THINKING_FORMATS as readonly unknown[]).includes(r.thinkingFormat)
		? (r.thinkingFormat as EndpointThinkingFormat)
		: DEFAULT_ENDPOINT_THINKING_FORMAT;
	const seen = new Set<string>();
	const models: EndpointModel[] = [];
	for (const m of Array.isArray(r.models) ? r.models : []) {
		const cleaned = sanitizeModel(m);
		if (cleaned && !seen.has(cleaned.id)) {
			seen.add(cleaned.id);
			models.push(cleaned);
		}
	}
	return {
		id: r.id,
		name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : r.id,
		baseUrl,
		thinkingFormat,
		models,
	};
}

/** The read-side sanitizer for the `endpoints` section: malformed
 *  endpoints/models drop, duplicate ids keep the first. */
export function sanitizeEndpoints(raw: Record<string, unknown>): EndpointsSettings {
	if (!Array.isArray(raw.list)) return {};
	const seen = new Set<string>();
	const list: CustomEndpoint[] = [];
	for (const e of raw.list) {
		const cleaned = sanitizeEndpoint(e);
		if (cleaned && !seen.has(cleaned.id)) {
			seen.add(cleaned.id);
			list.push(cleaned);
		}
	}
	return list.length ? { list } : {};
}
