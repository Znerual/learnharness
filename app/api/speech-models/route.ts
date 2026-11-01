/**
 * GET /api/speech-models — the Android app's on-device speech models and
 * their download states (src/server/speech-models.ts). 404 when the speech
 * server is not an on-device one.
 */
import { listSpeechModels } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const result = await listSpeechModels();
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ models: result.models });
}
