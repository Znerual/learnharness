/**
 * Custom-endpoint model DETECTION (custom-endpoints wave, owner
 * 2026-10-24): the network half of core/endpoints.ts. Asks the server
 * what it serves — GET <baseUrl>/models, plus LM Studio's richer
 * <root>/api/v0/models when the server has one (vision + context) — and
 * hands both bodies to the pure parsers. Called by POST
 * /api/endpoints/detect; nothing here writes settings (the client
 * persists the result through the endpoints section PUT).
 */

import {
	endpointKeyVar,
	lmStudioV0Url,
	parseLmStudioModels,
	parseModelListing,
	type EndpointModel,
} from "../core/endpoints.ts";
import { normalizeBaseUrl } from "../core/settings.ts";
import { keyValue } from "./keys.ts";

const DETECT_TIMEOUT_MS = 10_000;

export type DetectResult = { ok: true; models: EndpointModel[] } | { ok: false; error: string };

async function getJson(url: string, apiKey: string | undefined, fetchFn: typeof fetch): Promise<{ status: number; body: unknown }> {
	const res = await fetchFn(url, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
	});
	const body = res.ok ? await res.json().catch(() => null) : null;
	return { status: res.status, body };
}

/**
 * Detect an endpoint's models. The key is the pasted one, else the
 * stored key of `endpointId` (editing an endpoint without retyping its
 * key), else none. LM Studio's listing is best-effort: any failure there
 * leaves the plain listing standing.
 */
export async function detectEndpointModels(
	input: { baseUrl: string; apiKey?: string; endpointId?: string },
	fetchFn: typeof fetch = fetch,
): Promise<DetectResult> {
	const baseUrl = normalizeBaseUrl(input.baseUrl);
	if (!baseUrl) return { ok: false, error: "Base URL must be an http(s) URL without query or fragment" };
	const apiKey = input.apiKey?.trim() || (input.endpointId ? keyValue(endpointKeyVar(input.endpointId)) : undefined);

	let listing: { status: number; body: unknown };
	try {
		listing = await getJson(`${baseUrl}/models`, apiKey, fetchFn);
	} catch (error) {
		const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
		return { ok: false, error: `${baseUrl}/models ${reason}` };
	}
	if (listing.status === 401 || listing.status === 403) {
		return { ok: false, error: `${baseUrl} refused the key (HTTP ${listing.status})` };
	}
	if (listing.status !== 200 || listing.body === null) {
		return { ok: false, error: `${baseUrl}/models answered HTTP ${listing.status}` };
	}

	let lmStudio = new Map<string, { type?: string; maxContextLength?: number }>();
	const v0 = lmStudioV0Url(baseUrl);
	if (v0) {
		try {
			const rich = await getJson(`${v0}/models`, apiKey, fetchFn);
			if (rich.status === 200) lmStudio = parseLmStudioModels(rich.body);
		} catch {
			// not LM Studio (or it hiccuped) — the plain listing stands
		}
	}

	const models = parseModelListing(listing.body, lmStudio);
	if (models.length === 0) return { ok: false, error: `${baseUrl} lists no chat models` };
	return { ok: true, models };
}
