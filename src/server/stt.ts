/**
 * LOCAL DICTATION (local-STT wave, owner 2026-10-24): the server half of
 * the "local" dictation engine. The renderer records the run, encodes one
 * 16 kHz WAV, and POSTs it to /api/stt/transcribe; this forwards it to the
 * configured OpenAI-compatible endpoint (<localUrl>/audio/transcriptions)
 * with the optional LH_STT_KEY as the bearer — the key never reaches the
 * renderer (the Deepgram token route's rule). Batch, not streaming: the
 * dictation UX inserts the transcript once, at the end, anyway.
 */

import { LOCAL_STT_KEY_ID, resolveDictation, type EffectiveDictation } from "../core/dictation.ts";
import { keyValue } from "./keys.ts";
import { settingsStore } from "../store/settings.ts";

const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** The resolved dictation choice, read fresh. */
export function dictationConfig(): EffectiveDictation {
	return resolveDictation(settingsStore.readSettings()?.dictation);
}

export type LocalTranscription = { ok: true; text: string } | { ok: false; status: number; error: string };

/** Forward one recording to the local endpoint and return its text. */
export async function transcribeLocally(audio: Blob, fetchFn: typeof fetch = fetch): Promise<LocalTranscription> {
	const config = dictationConfig();
	if (config.engine !== "local") return { ok: false, status: 409, error: "The dictation engine is not set to Local" };
	if (!config.localUrl) return { ok: false, status: 503, error: "Dictation needs a local speech-to-text URL" };

	const form = new FormData();
	form.append("file", audio, "dictation.wav");
	form.append("model", config.localModel ?? "whisper-1");
	form.append("response_format", "json");
	const key = keyValue(LOCAL_STT_KEY_ID);
	const url = `${config.localUrl}/audio/transcriptions`;

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: "POST",
			body: form,
			headers: key ? { Authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "is unreachable";
		return { ok: false, status: 502, error: `Local speech-to-text ${reason} (${config.localUrl})` };
	}
	const body = (await res.json().catch(() => null)) as { text?: unknown; error?: { message?: string } } | null;
	if (!res.ok) {
		const detail = body?.error?.message ?? `HTTP ${res.status}`;
		return { ok: false, status: 502, error: `Local speech-to-text failed: ${detail}` };
	}
	if (typeof body?.text !== "string") return { ok: false, status: 502, error: "Local speech-to-text returned no text" };
	return { ok: true, text: body.text.trim() };
}
