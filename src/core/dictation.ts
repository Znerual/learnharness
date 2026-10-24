/**
 * DICTATION ENGINE SETTINGS (local-STT wave, owner 2026-10-24): which
 * speech-to-text engine dictation runs on. An EXPLICIT choice (owner
 * ruling) — "deepgram" (the cloud default, streaming) or "local" (an
 * OpenAI-compatible `/audio/transcriptions` endpoint, e.g. AudioAgent);
 * no silent fallback between them. The local endpoint's optional key
 * lives in auth.json as LH_STT_KEY, never here.
 *
 * PURE, browser-safe: shape, sanitizer, resolution.
 */

import { normalizeBaseUrl } from "./endpoints.ts";

export const DICTATION_ENGINES = ["deepgram", "local"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

/** The `dictation` settings section (delta — absent = default). */
export interface DictationSettings {
	engine?: DictationEngine;
	/** The local endpoint's OpenAI-style base URL ("http://host:8110/v1");
	 *  dictation POSTs to <localUrl>/audio/transcriptions. */
	localUrl?: string;
	/** Sent as the request's `model` field (servers that host several
	 *  models pick by it; AudioAgent ignores it). */
	localModel?: string;
}

/** The resolved view every consumer reads. */
export interface EffectiveDictation {
	engine: DictationEngine;
	localUrl: string | null;
	localModel: string | null;
}

/** The env/auth.json var of the local endpoint's optional key. */
export const LOCAL_STT_KEY_ID = "LH_STT_KEY";

export function resolveDictation(section: DictationSettings | undefined): EffectiveDictation {
	return {
		engine: section?.engine ?? "deepgram",
		localUrl: section?.localUrl ?? null,
		localModel: section?.localModel ?? null,
	};
}

/** Read side: lenient — malformed fields drop to their defaults. */
export function sanitizeDictation(raw: Record<string, unknown>): DictationSettings {
	const out: DictationSettings = {};
	if ((DICTATION_ENGINES as readonly unknown[]).includes(raw.engine)) out.engine = raw.engine as DictationEngine;
	if (typeof raw.localUrl === "string") {
		const url = normalizeBaseUrl(raw.localUrl);
		if (url) out.localUrl = url;
	}
	if (typeof raw.localModel === "string" && raw.localModel.trim()) out.localModel = raw.localModel.trim();
	return out;
}
