/**
 * POST /api/stt/transcribe — the "local" dictation engine's transport
 * (local-STT wave, 2026-10-24). Multipart field "file": one WAV of the
 * whole run. Forwarded to the configured OpenAI-compatible endpoint
 * (src/server/stt.ts); 200 {text}, or {message} with 400 (no file), 409
 * (engine is not Local), 503 (no URL), 502 (the endpoint failed).
 */
import { transcribeLocally } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const form = await request.formData().catch(() => null);
	const file = form?.get("file");
	if (!(file instanceof Blob) || file.size === 0) {
		return Response.json({ message: "body must be multipart with a non-empty \"file\"" }, { status: 400 });
	}
	const result = await transcribeLocally(file);
	if (!result.ok) return Response.json({ message: result.error }, { status: result.status });
	return Response.json({ text: result.text });
}
