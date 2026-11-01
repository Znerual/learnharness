/**
 * CUSTOM ENDPOINTS (custom-endpoints wave, owner 2026-10-24): user-added
 * OpenAI-compatible servers (vLLM, LM Studio, Ollama, llama.cpp, …) that
 * join pi-ai's builtin providers as first-class model sources. The stored
 * shape is upstream's custom provider, one per entry of the
 * `customProviders` list (core/settings.ts); this module owns what the list
 * adds to it:
 *  - the thinking formats (how "thinking on" reaches a server),
 *  - the slug + key-variable rules (an entry's key lives in auth.json under
 *    LH_ENDPOINT_<ID>_KEY — "custom" keeps upstream's CUSTOM_OPENAI_API_KEY),
 *  - LM Studio's richer listing, which discovery reads beside /models,
 *  - the legacy `endpoints` section, read once by the migration into
 *    `customProviders` (src/server/custom-provider-migration.ts).
 *
 * PURE, browser-safe — no fs, no env, no network.
 */

import { normalizeBaseUrl } from "./settings.ts";

/** How thinking reaches the server: "openai" — pi's reasoning_effort with
 *  every effort level (upstream's custom endpoint); the Qwen ones — ON/OFF
 *  only, sent as pi-ai's openai-completions thinkingFormat; or "none" — never
 *  send thinking params, the model runs its own default. */
export const ENDPOINT_THINKING_FORMATS = ["qwen-chat-template", "qwen", "openai", "none"] as const;
export type EndpointThinkingFormat = (typeof ENDPOINT_THINKING_FORMATS)[number];
export const DEFAULT_ENDPOINT_THINKING_FORMAT: EndpointThinkingFormat = "openai";

/** Thinking is ON/OFF only for these formats (the pickers label "high" as "on"). */
export function isOnOffThinkingFormat(format: EndpointThinkingFormat | undefined): boolean {
	return format === "qwen-chat-template" || format === "qwen";
}

/** One-line labels for the settings form's thinking-format select. */
export const ENDPOINT_THINKING_FORMAT_LABEL: Record<EndpointThinkingFormat, string> = {
	"qwen-chat-template": "chat_template_kwargs.enable_thinking (Qwen on vLLM / LM Studio)",
	qwen: "top-level enable_thinking",
	openai: "reasoning_effort (every effort level)",
	none: "never send — model default",
};

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

// ─── LM Studio (read beside /models by discovery) ──────────────────────────

const positiveInt = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** LM Studio's richer listing (GET <root>/api/v0/models) — per id. */
export interface LmStudioModelInfo {
	type?: string;
	maxContextLength?: number;
}

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
export function isEmbeddingModel(id: string, info: LmStudioModelInfo | undefined): boolean {
	if (info?.type === "embeddings") return true;
	return /embed/i.test(id);
}

/** LM Studio's /api/v0 root for an OpenAI-style base URL ("…/v1" →
 *  "…/api/v0"); null when the URL does not end in /v1. */
export function lmStudioV0Url(baseUrl: string): string | null {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? `${trimmed.slice(0, -3)}/api/v0` : null;
}

// ─── the legacy `endpoints` section (read by the migration only) ────────────

/** Context window a legacy model fell back to when the server reported none. */
const LEGACY_FALLBACK_CONTEXT_WINDOW = 32_768;
const legacyMaxTokens = (contextWindow: number): number => Math.max(1024, Math.min(16_384, Math.floor(contextWindow / 2)));

/** The model values detection fills and the user may override. */
export interface LegacyEndpointModelValues {
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
	reasoning: boolean;
}

/** One stored model: the DETECTED values plus optional user overrides
 *  (a re-detect replaces the detected half and keeps the overrides). */
export interface LegacyEndpointModel extends LegacyEndpointModelValues {
	id: string;
	overrides?: Partial<LegacyEndpointModelValues>;
}

/** One legacy endpoint. `id` doubles as the pi-ai provider id. */
export interface LegacyEndpoint {
	id: string;
	name: string;
	baseUrl: string;
	thinkingFormat: EndpointThinkingFormat;
	models: LegacyEndpointModel[];
}

/** The legacy `endpoints` settings section. */
export interface LegacyEndpointsSettings {
	list?: LegacyEndpoint[];
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function sanitizeOverrides(raw: unknown): Partial<LegacyEndpointModelValues> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const out: Partial<LegacyEndpointModelValues> = {};
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

function sanitizeModel(raw: unknown): LegacyEndpointModel | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id.trim()) return undefined;
	const contextWindow = positiveInt(r.contextWindow) ?? LEGACY_FALLBACK_CONTEXT_WINDOW;
	const model: LegacyEndpointModel = {
		id: r.id,
		contextWindow,
		maxTokens: positiveInt(r.maxTokens) ?? legacyMaxTokens(contextWindow),
		vision: bool(r.vision) ?? false,
		reasoning: bool(r.reasoning) ?? true,
	};
	const overrides = sanitizeOverrides(r.overrides);
	if (overrides) model.overrides = overrides;
	return model;
}

function sanitizeEndpoint(raw: unknown): LegacyEndpoint | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !isValidEndpointId(r.id)) return undefined;
	const baseUrl = typeof r.baseUrl === "string" ? normalizeBaseUrl(r.baseUrl) : null;
	if (!baseUrl) return undefined;
	const thinkingFormat = (ENDPOINT_THINKING_FORMATS as readonly unknown[]).includes(r.thinkingFormat)
		? (r.thinkingFormat as EndpointThinkingFormat)
		: "qwen-chat-template"; // the legacy default
	const seen = new Set<string>();
	const models: LegacyEndpointModel[] = [];
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

/** Reads a legacy `endpoints` section: malformed endpoints/models drop,
 *  duplicate ids keep the first. */
export function sanitizeLegacyEndpoints(raw: Record<string, unknown>): LegacyEndpointsSettings {
	if (!Array.isArray(raw.list)) return {};
	const seen = new Set<string>();
	const list: LegacyEndpoint[] = [];
	for (const e of raw.list) {
		const cleaned = sanitizeEndpoint(e);
		if (cleaned && !seen.has(cleaned.id)) {
			seen.add(cleaned.id);
			list.push(cleaned);
		}
	}
	return list.length ? { list } : {};
}
