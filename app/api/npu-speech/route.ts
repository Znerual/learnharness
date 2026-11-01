/**
 * GET /api/npu-speech — the phone's NPU speech state; PUT {enabled} — the
 * switch (src/server/speech-models.ts npuSpeech). 404 when the speech
 * server is not an on-device one.
 */
import { npuSpeech } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const call = await npuSpeech("GET");
	if (!call.ok) return Response.json({ error: call.error }, { status: call.status });
	return Response.json(call.status);
}

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
	const call = await npuSpeech("PUT", body.enabled === true);
	if (!call.ok) return Response.json({ error: call.error }, { status: call.status });
	return Response.json(call.status);
}
