/**
 * READ-ALOUD (read-aloud wave, owner 2026-10-24): the server half. The
 * renderer splits a reply into spoken blocks (core/speech-script.ts) and
 * POSTs one block at a time to /api/tts/speak; this turns the block's
 * math into words and forwards the text to the configured
 * OpenAI-compatible endpoint (<url>/audio/speech, e.g. AudioAgent's Kokoro
 * sidecar) with the optional LH_TTS_KEY as the bearer — the key never
 * reaches the renderer (the dictation routes' rule). The audio streams
 * back untouched.
 *
 * MATH (owner ruling): deterministic, offline — server/math-speech.ts
 * reads each formula in words: "\frac{a}{b} + x^2" → "a over b plus x
 * squared". English only, like the Kokoro voices.
 */

import { resolveSpeech, SPEECH_KEY_ID, type EffectiveSpeech } from "../core/speech.ts";
import type { SpeechSegment } from "../core/speech-script.ts";
import { keyValue } from "./keys.ts";
import { speakMath } from "./math-speech.ts";
import { settingsStore } from "../store/settings.ts";

const SPEAK_TIMEOUT_MS = 60_000;
const VOICES_TIMEOUT_MS = 5_000;
/** OpenAI's audio/speech input cap. */
export const SPEECH_INPUT_MAX = 4096;

/** The resolved read-aloud choice, read fresh. */
export function speechConfig(): EffectiveSpeech {
	return resolveSpeech(settingsStore.readSettings()?.speech);
}

/** One block's segments → the text the voice reads. */
export async function speechText(segments: SpeechSegment[]): Promise<string> {
	const parts: string[] = [];
	for (const segment of segments) {
		parts.push(segment.kind === "math" ? await speakMath(segment.latex) : segment.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** Strict shape check of a /api/tts/speak body's `segments`. */
export function parseSpeechSegments(raw: unknown): SpeechSegment[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: SpeechSegment[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") return null;
		const { kind, text, latex } = item as Record<string, unknown>;
		if (kind === "text" && typeof text === "string") out.push({ kind, text });
		else if (kind === "math" && typeof latex === "string") out.push({ kind, latex });
		else return null;
	}
	return out;
}

// ─── the endpoint ────────────────────────────────────────────────────────────

export type SpeechAudio =
	| { ok: true; body: ReadableStream<Uint8Array>; contentType: string }
	| { ok: false; status: number; error: string };

function authHeaders(): Record<string, string> {
	const key = keyValue(SPEECH_KEY_ID);
	return key ? { Authorization: `Bearer ${key}` } : {};
}

async function upstreamError(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
	return body?.error?.message ?? `HTTP ${res.status}`;
}

/** Speak one block: math to words, then the endpoint's audio stream. */
export async function synthesizeSpeech(segments: SpeechSegment[], fetchFn: typeof fetch = fetch): Promise<SpeechAudio> {
	const config = speechConfig();
	if (!config.url) return { ok: false, status: 503, error: "Read-aloud needs a text-to-speech URL" };

	let input: string;
	try {
		input = await speechText(segments);
	} catch (error) {
		console.error("[tts] math to speech failed", error);
		return { ok: false, status: 500, error: "Could not read the formulas aloud" };
	}
	if (!input) return { ok: false, status: 400, error: "Nothing to read aloud" };
	if (input.length > SPEECH_INPUT_MAX) input = input.slice(0, SPEECH_INPUT_MAX);

	const body: Record<string, unknown> = { model: "tts-1", input, response_format: "mp3", speed: config.speed };
	if (config.voice) body.voice = config.voice;

	let res: Response;
	try {
		res = await fetchFn(`${config.url}/audio/speech`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders() },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "is unreachable";
		return { ok: false, status: 502, error: `Text-to-speech ${reason} (${config.url})` };
	}
	if (!res.ok) return { ok: false, status: 502, error: `Text-to-speech failed: ${await upstreamError(res)}` };
	if (!res.body) return { ok: false, status: 502, error: "Text-to-speech returned no audio" };
	return { ok: true, body: res.body, contentType: res.headers.get("content-type") ?? "audio/mpeg" };
}

export type SpeechVoices = { ok: true; voices: string[] } | { ok: false; status: number; error: string };

/** The endpoint's voice names (AudioAgent's GET /v1/audio/voices). */
export async function listSpeechVoices(fetchFn: typeof fetch = fetch): Promise<SpeechVoices> {
	const config = speechConfig();
	if (!config.url) return { ok: false, status: 503, error: "Read-aloud needs a text-to-speech URL" };
	let res: Response;
	try {
		res = await fetchFn(`${config.url}/audio/voices`, {
			headers: authHeaders(),
			signal: AbortSignal.timeout(VOICES_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, status: 502, error: `Text-to-speech is unreachable (${config.url})` };
	}
	if (!res.ok) return { ok: false, status: 502, error: `Voice list failed: ${await upstreamError(res)}` };
	const body = (await res.json().catch(() => null)) as { voices?: unknown } | null;
	const voices = Array.isArray(body?.voices)
		? body.voices.map((v) => (typeof v === "string" ? v : (v as { id?: unknown })?.id)).filter((v): v is string => typeof v === "string")
		: [];
	return { ok: true, voices };
}
