/**
 * GET /api/tts/voices — the text-to-speech endpoint's voice names
 * (read-aloud wave, 2026-10-24), for the settings voice picker: 200
 * {voices}, or {message} with 503 (no URL) / 502 (the endpoint failed).
 */
import { listSpeechVoices } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const result = await listSpeechVoices();
	if (!result.ok) return Response.json({ message: result.error }, { status: result.status });
	return Response.json({ voices: result.voices });
}
