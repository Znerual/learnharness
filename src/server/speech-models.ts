/**
 * ON-DEVICE SPEECH MODELS (Android app, owner 2026-11-01): the phone's own
 * speech server (the read-aloud URL, or else the dictation URL — the
 * Android app points both at it) downloads its models only when the
 * learner asks, in Settings → Providers → On-device speech. These calls
 * forward that section's reads and choices to the server's
 *
 *   GET    <url>/models        → {models: OnDeviceModel[]}
 *   POST   <url>/models/<id>   → start the download (Wi-Fi only)
 *   DELETE <url>/models/<id>   → remove the model's files
 *
 * with the server's key as the bearer. A server without these routes is
 * not an on-device one: the section stays hidden.
 */

import { LOCAL_STT_KEY_ID, resolveDictation } from "../core/dictation.ts";
import { resolveSpeech, SPEECH_KEY_ID, type OnDeviceModel } from "../core/speech.ts";
import { settingsStore } from "../store/settings.ts";
import { keyValue } from "./keys.ts";

const TIMEOUT_MS = 5_000;

export type SpeechModelsResult = { ok: true; models: OnDeviceModel[] } | { ok: false; status: number; error: string };

/** The on-device server's base URL and key, if one is configured. */
function server(): { url: string; key: string | undefined } | null {
	const settings = settingsStore.readSettings();
	const speech = resolveSpeech(settings?.speech);
	if (speech.url) return { url: speech.url, key: keyValue(SPEECH_KEY_ID) };
	const dictation = resolveDictation(settings?.dictation);
	if (dictation.localUrl) return { url: dictation.localUrl, key: keyValue(LOCAL_STT_KEY_ID) };
	return null;
}

async function call(method: "GET" | "POST" | "DELETE", path: string, fetchFn: typeof fetch): Promise<SpeechModelsResult> {
	const target = server();
	if (!target) return { ok: false, status: 404, error: "No speech server is set" };
	let res: Response;
	try {
		res = await fetchFn(`${target.url}${path}`, {
			method,
			headers: target.key ? { Authorization: `Bearer ${target.key}` } : {},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, status: 502, error: `The speech server is unreachable (${target.url})` };
	}
	const body = (await res.json().catch(() => null)) as { models?: unknown; error?: { message?: string } } | null;
	if (!res.ok) return { ok: false, status: res.status === 404 ? 404 : 502, error: body?.error?.message ?? `HTTP ${res.status}` };
	return { ok: true, models: Array.isArray(body?.models) ? (body.models as OnDeviceModel[]) : [] };
}

/** The phone's speech models and their states. */
export function listSpeechModels(fetchFn: typeof fetch = fetch): Promise<SpeechModelsResult> {
	return call("GET", "/models", fetchFn);
}

/** Download (POST) or remove (DELETE) one model; answers the new list. */
export async function changeSpeechModel(id: string, method: "POST" | "DELETE", fetchFn: typeof fetch = fetch): Promise<SpeechModelsResult> {
	if (!/^[a-z0-9-]+$/.test(id)) return { ok: false, status: 400, error: "Unknown model" };
	const done = await call(method, `/models/${id}`, fetchFn);
	return done.ok ? listSpeechModels(fetchFn) : done;
}
