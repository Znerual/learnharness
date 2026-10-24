/**
 * READ-ALOUD SETTINGS (read-aloud wave, owner 2026-10-24): where teacher
 * replies are spoken. Its own section, separate from dictation (owner
 * ruling) — text-to-speech may live on a different server than
 * speech-to-text. The endpoint is OpenAI-compatible `/audio/speech`
 * (e.g. AudioAgent's Kokoro sidecar); the optional key lives in auth.json
 * as LH_TTS_KEY, never here. `autoRead` is the composer toggle, persisted
 * globally (owner ruling).
 *
 * PURE, browser-safe: shape, sanitizer, resolution.
 */

import { normalizeBaseUrl } from "./endpoints.ts";

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
}

/** The resolved view every consumer reads. */
export interface EffectiveSpeech {
	url: string | null;
	voice: string | null;
	speed: number;
	autoRead: boolean;
}

/** The env/auth.json var of the endpoint's optional key. */
export const SPEECH_KEY_ID = "LH_TTS_KEY";

/** OpenAI's audio/speech speed range (Kokoro accepts the same). */
export const SPEECH_SPEED_MIN = 0.25;
export const SPEECH_SPEED_MAX = 4;

export function isSpeechSpeed(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= SPEECH_SPEED_MIN && value <= SPEECH_SPEED_MAX;
}

export function resolveSpeech(section: SpeechSettings | undefined): EffectiveSpeech {
	return {
		url: section?.url ?? null,
		voice: section?.voice ?? null,
		speed: section?.speed ?? 1,
		autoRead: section?.autoRead ?? false,
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
	return out;
}
