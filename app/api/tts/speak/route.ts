/**
 * POST /api/tts/speak — read one spoken block aloud (read-aloud wave,
 * 2026-10-24). Body {segments: SpeechSegment[]} (core/speech-script.ts):
 * the math becomes words here, the text goes to the configured
 * OpenAI-compatible /audio/speech endpoint (src/server/tts.ts), and its
 * audio streams back. Errors are {message} with 400 (bad body / nothing to
 * say), 500 (math engine), 503 (no URL), 502 (the endpoint failed).
 */
import { parseSpeechSegments, synthesizeSpeech } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { segments?: unknown } | null;
	const segments = parseSpeechSegments(body?.segments);
	if (!segments) {
		return Response.json({ message: "body must be {segments: [{kind: \"text\", text} | {kind: \"math\", latex}, …]}" }, { status: 400 });
	}
	const result = await synthesizeSpeech(segments);
	if (!result.ok) return Response.json({ message: result.error }, { status: result.status });
	return new Response(result.body, { headers: { "Content-Type": result.contentType, "Cache-Control": "no-store" } });
}
