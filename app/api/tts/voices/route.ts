/**
 * /api/tts/voices — the chosen read-aloud engine's voices (read-aloud wave,
 * 2026-10-24; engines and voice clips, owner 2026-11-09).
 * GET: 200 {voices}, or {message} with 503 (no URL) / 502 (the endpoint failed).
 * POST (multipart: name, transcript, audio — a 3–10 s WAV or MP3): adds a voice
 * clip to the chosen engine; 201 {id, name}, or {message, code?} with 400 (bad
 * clip), 409 (voice_exists), 503 (no URL), 502 (the endpoint failed or takes no clips).
 */
import { addSpeechClip, listSpeechVoices } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const result = await listSpeechVoices();
	if (!result.ok) return Response.json({ message: result.error }, { status: result.status });
	return Response.json({ voices: result.voices });
}

export async function POST(request: Request) {
	const form = await request.formData().catch(() => null);
	const name = form?.get("name");
	const transcript = form?.get("transcript");
	const audio = form?.get("audio");
	if (typeof name !== "string" || typeof transcript !== "string" || !(audio instanceof Blob)) {
		return Response.json({ message: "body must be multipart with name, transcript and audio" }, { status: 400 });
	}
	const result = await addSpeechClip({ name, transcript, audio: new Uint8Array(await audio.arrayBuffer()) });
	if (!result.ok) return Response.json({ message: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
	return Response.json({ id: result.id, name: result.name }, { status: 201 });
}
