import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import { effectiveModelValues, endpointKeyVar, type CustomEndpoint, type EndpointModel } from "../core/endpoints.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent.
 *
 *  Custom endpoints (custom-endpoints wave, 2026-10-24) join the same
 *  collection: every call re-syncs them from the registered source (the
 *  settings record, read fresh — a settings PUT lands on the next call). */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	if (endpointSource) syncCustomEndpoints(collection, endpointSource());
	return collection;
}

/** The builtin pi-ai provider ids — a custom endpoint id must not shadow one. */
export function builtinProviderIds(): Set<string> {
	return new Set(builtinProviders().map((p) => p.id));
}

// ─── custom endpoints (custom-endpoints wave, 2026-10-24) ──────────────────

/** Where the endpoint definitions come from. Registered by the server's
 *  composition root (this layer never reads settings — the setTurnRunner
 *  pattern); unset (tests, scripts) = no custom providers. */
let endpointSource: (() => readonly CustomEndpoint[]) | undefined;
/** Fingerprint of the last synced definitions → ids it registered. */
let syncedFingerprint = "";
let syncedIds: string[] = [];

export function setCustomEndpointSource(source: (() => readonly CustomEndpoint[]) | undefined): void {
	endpointSource = source;
}

/** Placeholder bearer for keyless endpoints — pi-ai's OpenAI client
 *  refuses an empty key; keyless servers ignore the header. */
const KEYLESS_PLACEHOLDER = "no-key";

/** One stored model → the pi Model it runs as. Thinking is ON/OFF only
 *  (owner ruling): the level map leaves exactly off + high, and the
 *  endpoint's format decides what "on" sends. Costs are zero — self-hosted. */
export function customEndpointModel(endpoint: CustomEndpoint, stored: EndpointModel): Model<"openai-completions"> {
	const values = effectiveModelValues(stored);
	const reasoning = values.reasoning && endpoint.thinkingFormat !== "none";
	return {
		id: stored.id,
		name: stored.id,
		api: "openai-completions",
		provider: endpoint.id,
		baseUrl: endpoint.baseUrl,
		reasoning,
		...(reasoning ? { thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" } } : {}),
		input: values.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: values.contextWindow,
		maxTokens: values.maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: endpoint.thinkingFormat === "openai",
			supportsStore: false,
			...(endpoint.thinkingFormat !== "none" ? { thinkingFormat: endpoint.thinkingFormat } : {}),
		},
	};
}

/** One endpoint → its pi provider. The key is read from the env per
 *  request (the keys seam reflects auth.json there), optional. */
export function customEndpointProvider(endpoint: CustomEndpoint) {
	const keyVar = endpointKeyVar(endpoint.id);
	return createProvider({
		id: endpoint.id,
		name: endpoint.name,
		baseUrl: endpoint.baseUrl,
		auth: {
			apiKey: {
				name: endpoint.name,
				resolve: async () => ({ auth: { apiKey: process.env[keyVar] || KEYLESS_PLACEHOLDER } }),
			},
		},
		models: endpoint.models.map((m) => customEndpointModel(endpoint, m)),
		api: openAICompletionsApi(),
	});
}

/** Make the collection's custom providers match `endpoints` exactly —
 *  a no-op when nothing changed since the last sync. */
function syncCustomEndpoints(models: ReturnType<typeof createModels>, endpoints: readonly CustomEndpoint[]): void {
	const fingerprint = JSON.stringify(endpoints);
	if (fingerprint === syncedFingerprint) return;
	const builtin = builtinProviderIds();
	for (const id of syncedIds) models.deleteProvider(id);
	syncedIds = [];
	for (const endpoint of endpoints) {
		if (builtin.has(endpoint.id)) continue; // the write gate refuses these; a hand edit never shadows a builtin
		models.setProvider(customEndpointProvider(endpoint));
		syncedIds.push(endpoint.id);
	}
	syncedFingerprint = fingerprint;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const models: Models = piModels();
	const model = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) => {
			const stream = spec.provider === "chatgpt" ? chatGPTStream(typeof background === "function" ? background : () => background, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level });
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
