/**
 * The built-in voice engine (owner, 2026-11-09): OmniVoice on this computer
 * through omnivoice-rs, for read-aloud without a speech server. See
 * docs/adr/0006-built-in-omnivoice-voice-engine.md.
 */

import { omniVoiceSpeech, OmniVoiceUnavailable } from "./engine.ts";
import { clipAudio, listClips, readClip } from "./clips.ts";
import { OMNIVOICE_DEFAULT_PRESET, OMNIVOICE_PRESETS, omniVoicePreset } from "./presets.ts";

export { OMNIVOICE_LICENSES } from "./assets.ts";
export { addClip, checkClip, deleteClip, listClips, type ClipInput, type SpeechClip } from "./clips.ts";
export { omniVoiceRunning, stopOmniVoice, OmniVoiceUnavailable } from "./engine.ts";
export { omniVoiceStatus, removeOmniVoice, startOmniVoiceInstall, type OmniVoiceStatus } from "./install.ts";
export { OMNIVOICE_PRESETS } from "./presets.ts";

/** The voice ids the built-in engine offers: the presets, then the clips. */
export async function builtinVoiceIds(): Promise<string[]> {
	return [...OMNIVOICE_PRESETS.map((p) => p.id), ...(await listClips()).map((c) => c.id)];
}

export interface BuiltinSpeechRequest {
	input: string;
	/** null: the default preset. */
	voice: string | null;
	language: string;
	speed: number;
}

export type BuiltinSpeech =
	| { ok: true; body: Uint8Array<ArrayBuffer>; contentType: string }
	| { ok: false; status: number; error: string };

/** Speak one block with the built-in engine: a preset as JSON, a clip as multipart with its recording. */
export async function builtinSpeech(request: BuiltinSpeechRequest): Promise<BuiltinSpeech> {
	const common = { model: "tts-1", input: request.input, language: request.language, speed: request.speed, response_format: "mp3" };
	let body: string | FormData;
	const preset = request.voice ? omniVoicePreset(request.voice) : OMNIVOICE_DEFAULT_PRESET;
	if (preset) {
		body = JSON.stringify({ ...common, instructions: preset.instruct, seed: preset.seed });
	} else {
		const clip = request.voice ? await readClip(request.voice) : null;
		if (!clip) return { ok: false, status: 400, error: `Unknown voice: ${request.voice}` };
		const form = new FormData();
		for (const [key, value] of Object.entries(common)) form.append(key, String(value));
		form.append("ref_text", clip.transcript);
		const audio = await clipAudio(clip);
		form.append("ref_audio", new Blob([audio], { type: clip.kind === "wav" ? "audio/wav" : "audio/mpeg" }), `ref.${clip.kind}`);
		body = form;
	}
	try {
		const reply = await omniVoiceSpeech(body);
		if (reply.status >= 400) {
			let message = `HTTP ${reply.status}`;
			try {
				message = (JSON.parse(new TextDecoder().decode(reply.body)) as { error?: { message?: string } }).error?.message ?? message;
			} catch {
				// not JSON
			}
			return { ok: false, status: 502, error: `The voice engine failed: ${message}` };
		}
		return { ok: true, body: reply.body, contentType: reply.contentType };
	} catch (error) {
		if (error instanceof OmniVoiceUnavailable) return { ok: false, status: 503, error: error.message };
		return { ok: false, status: 502, error: error instanceof Error ? error.message : "The voice engine failed" };
	}
}
