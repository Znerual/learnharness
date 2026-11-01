/** Private custom credential authorization; no credential-derived public value. */
import { CUSTOM_PROVIDER } from "./auth-keys.ts";
import { endpointKeyVar, isEndpointKeyVar } from "./endpoints.ts";
import { normalizeBaseUrl, type CustomProviderSettings } from "./settings.ts";

export const CUSTOM_AUTH_BINDING = "__learnharness_custom_provider_binding";

/** One custom endpoint's binding record name in auth.json: upstream's own
 *  for "custom", suffixed with the id for every other entry. */
export function customBindingVar(id: string): string {
	return id === CUSTOM_PROVIDER.id ? CUSTOM_AUTH_BINDING : `${CUSTOM_AUTH_BINDING}:${id}`;
}

/** One custom endpoint's key variable: upstream's CUSTOM_OPENAI_API_KEY for
 *  "custom", LH_ENDPOINT_<ID>_KEY for every other entry. */
export function customKeyVar(id: string): string {
	return id === CUSTOM_PROVIDER.id ? CUSTOM_PROVIDER.envVar : endpointKeyVar(id);
}

/** Is `name` a custom endpoint's binding record? */
export function isCustomBindingVar(name: string): boolean {
	return name === CUSTOM_AUTH_BINDING || name.startsWith(`${CUSTOM_AUTH_BINDING}:`);
}

/** Is `name` a custom endpoint's binding record or key variable? Those are
 *  written only through the custom endpoint editor, never the generic key API. */
export function isCustomAuthVar(name: string): boolean {
	return isCustomBindingVar(name) || name === CUSTOM_PROVIDER.envVar || isEndpointKeyVar(name);
}
export interface CustomAuthBinding {
	version: 1;
	id: string;
	baseUrl?: string;
	authMode: "apiKey" | "keyless" | "disabled";
	/** A shadowed file key keeps its own destination when an env key moves. */
	fileKeyBaseUrl?: string;
}
export function parseCustomAuthBinding(value: unknown): CustomAuthBinding | undefined {
	try {
		const b = typeof value === "string" ? JSON.parse(value) : undefined;
		if (!b || b.version !== 1 || typeof b.id !== "string" || !/^[a-f0-9]{32}$/.test(b.id)) return;
		if (!["apiKey", "keyless", "disabled"].includes(b.authMode)) return;
		if (b.authMode !== "disabled" && b.baseUrl === undefined) return;
		if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || !b.baseUrl || normalizeBaseUrl(b.baseUrl) !== b.baseUrl)) return;
		if (b.fileKeyBaseUrl !== undefined && (typeof b.fileKeyBaseUrl !== "string" || !b.fileKeyBaseUrl || normalizeBaseUrl(b.fileKeyBaseUrl) !== b.fileKeyBaseUrl)) return;
		return { version: 1, id: b.id, authMode: b.authMode, ...(b.baseUrl !== undefined ? { baseUrl: b.baseUrl } : {}), ...(b.fileKeyBaseUrl !== undefined ? { fileKeyBaseUrl: b.fileKeyBaseUrl } : {}) };
	} catch { return; }
}
export function customBindingMatches(cp: CustomProviderSettings | undefined, binding: CustomAuthBinding | undefined): boolean {
	return Boolean(cp?.baseUrl && binding && binding.authMode !== "disabled" && cp.credentialBindingId === binding.id && cp.baseUrl === binding.baseUrl && cp.authMode === binding.authMode);
}
