/**
 * READ-ALOUD (read-aloud wave, owner 2026-10-24): the server half. The
 * renderer splits a reply into spoken blocks (core/speech-script.ts) and
 * POSTs one block at a time to /api/tts/speak; this turns the block's
 * math into words and forwards the text to the configured
 * OpenAI-compatible endpoint (<url>/audio/speech, e.g. a Kokoro
 * sidecar) with the optional LH_TTS_KEY as the bearer — the key never
 * reaches the renderer (the dictation routes' rule). The audio streams
 * back untouched.
 *
 * MATH (owner ruling): deterministic, offline — server/math-speech.ts
 * reads each formula in words: "\frac{a}{b} + x^2" → "a over b plus x
 * squared". English only, like the Kokoro voices. A block that is one
 * formula alone — a display equation — is read slower (owner 2026-10-30):
 * SPEECH_MATH_SPEED_FACTOR of the chosen speed.
 *
 * ENGINES (owner, 2026-11-09): `speech.engine` "url" speaks through the
 * endpoint as above; "builtin" through OmniVoice on this computer
 * (server/omnivoice/). Both get the read-aloud language. Voice clips (voices
 * cloned from the user's recordings, ids "clip-…") live in the chosen engine:
 * the endpoint's POST/DELETE <url>/audio/voices (AudioAgent), or the built-in
 * engine's device-local store.
 */

import {
	isSpeechClipId,
	resolveSpeech,
	SPEECH_KEY_ID,
	SPEECH_MATH_SPEED_FACTOR,
	SPEECH_SPEED_MIN,
	speechVoice,
	type EffectiveSpeech,
	type SpeechLanguage,
	type SpeechVoice,
} from "../core/speech.ts";
import type { SpeechSegment } from "../core/speech-script.ts";
import { keyValue } from "./keys.ts";
import { speakMath } from "./math-speech.ts";
import { settingsStore } from "../store/settings.ts";
import { addClip, builtinSpeech, builtinVoiceIds, checkClip, deleteClip, omniVoiceStatus, omniVoiceRunning, type ClipInput } from "./omnivoice/index.ts";

const SPEAK_TIMEOUT_MS = 60_000;
const VOICES_TIMEOUT_MS = 5_000;
/** OpenAI's audio/speech input cap. */
export const SPEECH_INPUT_MAX = 4096;

/** The resolved read-aloud choice, read fresh. */
export function speechConfig(): EffectiveSpeech {
	return resolveSpeech(settingsStore.readSettings()?.speech);
}

/** One block's segments → the text the voice reads, formulas in `language`'s words. */
export async function speechText(segments: SpeechSegment[], language: SpeechLanguage = "en"): Promise<string> {
	const parts: string[] = [];
	for (const segment of segments) {
		parts.push(segment.kind === "math" ? await speakMath(segment.latex, language) : segment.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** The speed a block is read at: a formula alone is slower than prose. */
function blockSpeed(segments: SpeechSegment[], speed: number): number {
	if (segments.length !== 1 || segments[0]?.kind !== "math") return speed;
	return Math.max(SPEECH_SPEED_MIN, Math.round(speed * SPEECH_MATH_SPEED_FACTOR * 100) / 100);
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

/** `code` is the endpoint's machine-readable reason when it gives one: the Android app's speech
 *  server says "voice_not_downloaded" (or "voice_downloading") when the voice is not on the phone yet. */
export type SpeechAudio =
	| { ok: true; body: ReadableStream<Uint8Array>; contentType: string }
	| { ok: false; status: number; error: string; code?: string };

function authHeaders(): Record<string, string> {
	const key = keyValue(SPEECH_KEY_ID);
	return key ? { Authorization: `Bearer ${key}` } : {};
}

async function upstreamFailure(res: Response): Promise<{ message: string; code?: string }> {
	const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: unknown } } | null;
	const code = typeof body?.error?.code === "string" && /^[a-z_]{1,40}$/.test(body.error.code) ? body.error.code : undefined;
	return { message: body?.error?.message ?? `HTTP ${res.status}`, ...(code ? { code } : {}) };
}

async function upstreamError(res: Response): Promise<string> {
	return (await upstreamFailure(res)).message;
}

/** Speak one block: math to words, then the endpoint's audio stream. */
export async function synthesizeSpeech(segments: SpeechSegment[], fetchFn: typeof fetch = fetch): Promise<SpeechAudio> {
	const config = speechConfig();
	if (config.engine === "url" && !config.url) return { ok: false, status: 503, error: "Read-aloud needs a text-to-speech URL" };

	let input: string;
	try {
		input = await speechText(segments, config.language);
	} catch (error) {
		console.error("[tts] math to speech failed", error);
		return { ok: false, status: 500, error: "Could not read the formulas aloud" };
	}
	if (!input) return { ok: false, status: 400, error: "Nothing to read aloud" };
	if (input.length > SPEECH_INPUT_MAX) input = input.slice(0, SPEECH_INPUT_MAX);
	const speed = blockSpeed(segments, config.speed);

	if (config.engine === "builtin") {
		const spoken = await builtinSpeech({ input, voice: config.voice, language: config.language, speed });
		if (!spoken.ok) return spoken;
		return { ok: true, body: new Blob([spoken.body]).stream(), contentType: spoken.contentType };
	}

	// `language` for engines that read several (AudioAgent's OmniVoice); OpenAI-style servers ignore it.
	const body: Record<string, unknown> = { model: "tts-1", input, response_format: "mp3", speed, language: config.language };
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
	if (!res.ok) {
		const failure = await upstreamFailure(res);
		return { ok: false, status: 502, error: `Text-to-speech failed: ${failure.message}`, ...(failure.code ? { code: failure.code } : {}) };
	}
	if (!res.body) return { ok: false, status: 502, error: "Text-to-speech returned no audio" };
	return { ok: true, body: res.body, contentType: res.headers.get("content-type") ?? "audio/mpeg" };
}

export type SpeechVoices = { ok: true; voices: SpeechVoice[] } | { ok: false; status: number; error: string };

/** The endpoint's voice names (GET <url>/audio/voices — optional), or the built-in engine's. */
export async function listSpeechVoices(fetchFn: typeof fetch = fetch): Promise<SpeechVoices> {
	const config = speechConfig();
	// Every built-in voice reads English and German: no language, so the picker offers it for both.
	if (config.engine === "builtin") return { ok: true, voices: (await builtinVoiceIds()).map((id) => ({ id, language: null })) };
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
	// Names or {id, language?} objects; a Kokoro-style name tells its language.
	const voices = Array.isArray(body?.voices) ? body.voices.map(speechVoice).filter((v): v is SpeechVoice => v !== null) : [];
	return { ok: true, voices };
}

// ─── voice clips ─────────────────────────────────────────────────────────────

export type SpeechClipResult = { ok: true; id: string; name: string } | { ok: false; status: number; error: string; code?: string };

/** Add a voice clip to the chosen engine. The checks run here for both, so the endpoint only sees a valid clip. */
export async function addSpeechClip(input: ClipInput, fetchFn: typeof fetch = fetch): Promise<SpeechClipResult> {
	const config = speechConfig();
	if (config.engine === "builtin") {
		const added = await addClip(input);
		return added.ok ? { ok: true, id: added.clip.id, name: added.clip.name } : added;
	}
	if (!config.url) return { ok: false, status: 503, error: "Read-aloud needs a text-to-speech URL" };
	const checked = checkClip(input);
	if (!checked.ok) return checked;
	const form = new FormData();
	form.append("name", input.name.trim());
	form.append("transcript", input.transcript.trim());
	form.append("audio", new Blob([input.audio], { type: checked.kind === "wav" ? "audio/wav" : "audio/mpeg" }), `clip.${checked.kind}`);
	let res: Response;
	try {
		res = await fetchFn(`${config.url}/audio/voices`, { method: "POST", headers: authHeaders(), body: form, signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS) });
	} catch {
		return { ok: false, status: 502, error: `Text-to-speech is unreachable (${config.url})` };
	}
	if (!res.ok) {
		const failure = await upstreamFailure(res);
		// The endpoint's own refusals (409 voice_exists, 400 …) pass through; no clip support is a 502.
		const status = res.status === 404 || res.status === 405 ? 502 : res.status < 500 ? res.status : 502;
		const error = status === 502 && (res.status === 404 || res.status === 405) ? "This speech server does not take voice clips" : failure.message;
		return { ok: false, status, error, ...(failure.code ? { code: failure.code } : {}) };
	}
	const body = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
	return { ok: true, id: typeof body?.id === "string" ? body.id : checked.id, name: typeof body?.name === "string" ? body.name : input.name.trim() };
}

/** Delete a voice clip from the chosen engine. */
export async function deleteSpeechClip(id: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	if (!isSpeechClipId(id)) return { ok: false, status: 404, error: "No such voice clip" };
	const config = speechConfig();
	if (config.engine === "builtin") return (await deleteClip(id)) ? { ok: true } : { ok: false, status: 404, error: "No such voice clip" };
	if (!config.url) return { ok: false, status: 503, error: "Read-aloud needs a text-to-speech URL" };
	let res: Response;
	try {
		res = await fetchFn(`${config.url}/audio/voices/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders(), signal: AbortSignal.timeout(VOICES_TIMEOUT_MS) });
	} catch {
		return { ok: false, status: 502, error: `Text-to-speech is unreachable (${config.url})` };
	}
	if (res.status === 404) return { ok: false, status: 404, error: "No such voice clip" };
	if (!res.ok) return { ok: false, status: 502, error: `Deleting the voice failed: ${await upstreamError(res)}` };
	return { ok: true };
}

/** Whether read-aloud can speak: a URL is set, or the built-in engine is downloaded. */
export async function speechReady(): Promise<boolean> {
	const config = speechConfig();
	if (config.engine === "url") return config.url !== null;
	return (await omniVoiceStatus(omniVoiceRunning())).state === "ready";
}
