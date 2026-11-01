/**
 * READ-ALOUD SETTINGS (read-aloud wave, owner 2026-10-24): where teacher
 * replies are spoken. Its own section, separate from dictation (owner
 * ruling) — text-to-speech may live on a different server than
 * speech-to-text. The endpoint is OpenAI-compatible `/audio/speech`
 * (e.g. a Kokoro server, docs/local-speech.md); the optional key lives in auth.json
 * as LH_TTS_KEY, never here. `autoRead` is the composer toggle, persisted
 * globally (owner ruling).
 *
 * PURE, browser-safe: shape, sanitizer, resolution.
 */

import { normalizeBaseUrl } from "./settings.ts";

/** The `speech` settings section (delta — absent = default). */
export interface SpeechSettings {
	/** The endpoint's OpenAI-style base URL ("http://host:8110/v1");
	 *  read-aloud POSTs to <url>/audio/speech. */
	url?: string;
	/** A voice name from <url>/audio/voices; absent = the server's default. */
	voice?: string;
	/** Playback speed sent to the server, SPEECH_SPEED_MIN..SPEECH_SPEED_MAX. */
	speed?: number;
	/** Speak every live reply as it streams. */
	autoRead?: boolean;
	/** The read-aloud language (owner, 2026-11-01): the words formulas,
	 *  arrows and cues are read in, and which voices the list offers. */
	language?: SpeechLanguage;
}

/** The resolved view every consumer reads. */
export interface EffectiveSpeech {
	url: string | null;
	voice: string | null;
	speed: number;
	autoRead: boolean;
	language: SpeechLanguage;
}

/** The read-aloud languages (owner, 2026-11-01): English and German. */
export const SPEECH_LANGUAGES = ["en", "de"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];
export const SPEECH_LANGUAGE_LABEL: Record<SpeechLanguage, string> = { en: "English", de: "Deutsch" };

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
	return (SPEECH_LANGUAGES as readonly unknown[]).includes(value);
}

/** One voice an endpoint offers, with its language when known. */
export interface SpeechVoice {
	id: string;
	/** ISO 639-1 ("en", "de"); null when the endpoint does not say. */
	language: string | null;
}

/** Kokoro's voice names start with their language: a/b English, e Spanish,
 *  f French, h Hindi, i Italian, j Japanese, p Portuguese, z Chinese. */
const KOKORO_LANGUAGE: Record<string, string> = { a: "en", b: "en", e: "es", f: "fr", h: "hi", i: "it", j: "ja", p: "pt", z: "zh" };

/** A voice entry of GET <url>/audio/voices: a name, or {id, language?}.
 *  Without a language, a Kokoro-style name ("af_heart") tells it. */
export function speechVoice(raw: unknown): SpeechVoice | null {
	const id = typeof raw === "string" ? raw : typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : null;
	if (!id) return null;
	const said = (raw as { language?: unknown })?.language;
	if (typeof said === "string" && said.trim()) return { id, language: said.trim().slice(0, 2).toLowerCase() };
	const kokoro = /^([a-z])[fm]_/.exec(id);
	return { id, language: kokoro ? KOKORO_LANGUAGE[kokoro[1]!] ?? null : null };
}

/** The voices offered for a language: its own, plus those whose language is unknown. */
export function voicesFor(voices: readonly SpeechVoice[], language: SpeechLanguage): SpeechVoice[] {
	return voices.filter((v) => v.language === null || v.language === language);
}

/** The env/auth.json var of the endpoint's optional key. */
export const SPEECH_KEY_ID = "LH_TTS_KEY";

/** The owner's speed range (speed slider, owner 2026-10-24) — inside
 *  OpenAI's audio/speech 0.25–4, which Kokoro accepts too. */
export const SPEECH_SPEED_MIN = 0.5;
export const SPEECH_SPEED_MAX = 3;
/** The composer slider's and the Settings field's step. */
export const SPEECH_SPEED_STEP = 0.1;
/** A display equation is read slower than the prose around it (owner
 *  2026-10-30): this share of the chosen speed, never below the minimum. */
export const SPEECH_MATH_SPEED_FACTOR = 0.8;

export function isSpeechSpeed(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= SPEECH_SPEED_MIN && value <= SPEECH_SPEED_MAX;
}

export function resolveSpeech(section: SpeechSettings | undefined): EffectiveSpeech {
	return {
		url: section?.url ?? null,
		voice: section?.voice ?? null,
		speed: section?.speed ?? 1,
		autoRead: section?.autoRead ?? false,
		language: section?.language ?? "en",
	};
}

/** Read side: lenient — malformed fields drop to their defaults. */
export function sanitizeSpeech(raw: Record<string, unknown>): SpeechSettings {
	const out: SpeechSettings = {};
	if (typeof raw.url === "string") {
		const url = normalizeBaseUrl(raw.url);
		if (url) out.url = url;
	}
	if (typeof raw.voice === "string" && raw.voice.trim()) out.voice = raw.voice.trim();
	if (isSpeechSpeed(raw.speed)) out.speed = raw.speed;
	if (typeof raw.autoRead === "boolean") out.autoRead = raw.autoRead;
	if (isSpeechLanguage(raw.language)) out.language = raw.language;
	return out;
}

/** One on-device speech model, as the Android app's speech server reports
 *  it (GET <url>/models — src/server/speech-models.ts). */
export interface OnDeviceModel {
	id: string;
	kind: "dictation" | "voice";
	/** "auto" for dictation (it detects the language), else ISO 639-1. */
	language: string;
	label: string;
	bytes: number;
	state: "missing" | "waiting" | "downloading" | "ready" | "failed";
	/** 0..1 while downloading. */
	progress: number;
	error?: string;
}
