/**
 * THE BUILT-IN ENGINE'S VOICE CLIPS (owner, 2026-11-09): voices cloned from
 * the user's own recordings. Each clip is a 3–10 s WAV or MP3 plus the exact
 * words spoken in it (required: then no speech recognition is needed), kept
 * device-local in <local>/speech-voices/<id>/ (audio.<wav|mp3> + meta.json)
 * and sent along with every request that speaks with it. AudioAgent keeps its
 * own clips; a clip lives in the engine it was added to.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { isSpeechClipId, SPEECH_CLIP_MAX_SECONDS, SPEECH_CLIP_MIN_SECONDS, SPEECH_CLIP_NAME_MAX, speechClipId } from "../../core/speech.ts";
import { audioSeconds, type AudioKind } from "./audio-length.ts";

/** Largest accepted recording: 10 s of 48 kHz stereo 24-bit WAV is under 3 MB. */
export const CLIP_MAX_BYTES = 10 * 1024 * 1024;
export const CLIP_TRANSCRIPT_MAX = 1000;

export interface SpeechClip {
	id: string;
	name: string;
	transcript: string;
	kind: AudioKind;
	created: string;
}

export function clipsDir(): string {
	return path.join(PATHS.local, "speech-voices");
}

export type ClipInput = { name: string; transcript: string; audio: Uint8Array<ArrayBuffer> };

export type ClipFailure = { ok: false; status: number; error: string; code: string };

/** The shared checks of a new clip (both engines): name, transcript, a readable 3–10 s recording. */
export function checkClip(input: ClipInput): { ok: true; id: string; kind: AudioKind; seconds: number } | ClipFailure {
	const name = input.name.trim();
	if (!name || name.length > SPEECH_CLIP_NAME_MAX) return { ok: false, status: 400, error: `The name must be 1 to ${SPEECH_CLIP_NAME_MAX} characters`, code: "invalid_name" };
	const id = speechClipId(name);
	if (!id) return { ok: false, status: 400, error: "The name needs at least one letter or digit", code: "invalid_name" };
	const transcript = input.transcript.trim();
	if (!transcript) return { ok: false, status: 400, error: "Type the words spoken in the recording", code: "missing_transcript" };
	if (transcript.length > CLIP_TRANSCRIPT_MAX) return { ok: false, status: 400, error: `The transcript must be at most ${CLIP_TRANSCRIPT_MAX} characters`, code: "invalid_transcript" };
	if (input.audio.byteLength > CLIP_MAX_BYTES) return { ok: false, status: 400, error: "The recording is too large (10 MB at most)", code: "invalid_audio" };
	const length = audioSeconds(input.audio);
	if (!length) return { ok: false, status: 400, error: "The recording must be a WAV or MP3 file", code: "invalid_audio" };
	if (length.seconds < SPEECH_CLIP_MIN_SECONDS) return { ok: false, status: 400, error: `The recording must be at least ${SPEECH_CLIP_MIN_SECONDS} s long`, code: "audio_too_short" };
	if (length.seconds > SPEECH_CLIP_MAX_SECONDS + 0.05) return { ok: false, status: 400, error: `The recording must be at most ${SPEECH_CLIP_MAX_SECONDS} s long`, code: "audio_too_long" };
	return { ok: true, id, kind: length.kind, seconds: length.seconds };
}

export async function listClips(): Promise<SpeechClip[]> {
	const entries = await readdir(clipsDir(), { withFileTypes: true }).catch(() => []);
	const clips: SpeechClip[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isSpeechClipId(entry.name)) continue;
		const clip = await readClip(entry.name);
		if (clip) clips.push(clip);
	}
	return clips.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readClip(id: string): Promise<SpeechClip | null> {
	if (!isSpeechClipId(id)) return null;
	const raw = await readFile(path.join(clipsDir(), id, "meta.json"), "utf8").catch(() => null);
	if (!raw) return null;
	try {
		const meta = JSON.parse(raw) as Partial<SpeechClip>;
		if (meta.id !== id || typeof meta.name !== "string" || typeof meta.transcript !== "string" || (meta.kind !== "wav" && meta.kind !== "mp3")) return null;
		return { id, name: meta.name, transcript: meta.transcript, kind: meta.kind, created: typeof meta.created === "string" ? meta.created : "" };
	} catch {
		return null;
	}
}

export async function clipAudio(clip: SpeechClip): Promise<Uint8Array<ArrayBuffer>> {
	return Uint8Array.from(await readFile(path.join(clipsDir(), clip.id, `audio.${clip.kind}`)));
}

export async function addClip(input: ClipInput): Promise<{ ok: true; clip: SpeechClip } | ClipFailure> {
	const checked = checkClip(input);
	if (!checked.ok) return checked;
	if (await readClip(checked.id)) return { ok: false, status: 409, error: "A voice with this name exists already", code: "voice_exists" };
	const clip: SpeechClip = { id: checked.id, name: input.name.trim(), transcript: input.transcript.trim(), kind: checked.kind, created: new Date().toISOString() };
	const dir = path.join(clipsDir(), clip.id);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `audio.${clip.kind}`), input.audio);
	// meta.json last: a clip without it is not listed.
	await writeFile(path.join(dir, "meta.json"), JSON.stringify(clip, null, "\t") + "\n");
	return { ok: true, clip };
}

export async function deleteClip(id: string): Promise<boolean> {
	if (!(await readClip(id))) return false;
	await rm(path.join(clipsDir(), id), { recursive: true, force: true });
	return true;
}
