/**
 * DICTATION ENGINE SETTINGS (local-STT wave, owner 2026-10-24): which
 * speech-to-text engine dictation runs on. An EXPLICIT choice (owner
 * ruling) — "deepgram" (the cloud default, streaming) or "local" (an
 * OpenAI-compatible `/audio/transcriptions` endpoint, docs/local-speech.md);
 * no silent fallback between them. The local endpoint's optional key
 * lives in auth.json as LH_STT_KEY, never here. `language` is Deepgram's
 * (one of Nova-3's codes, below); the local engine detects the language.
 *
 * PURE, browser-safe: shape, sanitizer, resolution.
 */

import { normalizeBaseUrl } from "./settings.ts";

export const DICTATION_ENGINES = ["deepgram", "local"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

/** The `dictation` settings section (delta — absent = default). */
export interface DictationSettings {
	engine?: DictationEngine;
	/** The local endpoint's OpenAI-style base URL ("http://host:8110/v1");
	 *  dictation POSTs to <localUrl>/audio/transcriptions. */
	localUrl?: string;
	/** Sent as the request's `model` field (servers that host several
	 *  models pick by it; others ignore it). */
	localModel?: string;
	/** Deepgram's language (app-wide, shared by every composer). */
	language?: DictationLanguage;
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
	if (isDictationLanguage(raw.language)) out.language = raw.language;
	return out;
}

// ─── Deepgram languages ──────────────────────────────────────────────────────

/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}
