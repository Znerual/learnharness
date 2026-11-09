/**
 * GET /api/speech-models — the Android app's on-device speech models and
 * their download states, plus whether downloads may use mobile data
 * (src/server/speech-models.ts). PUT {mobileData} sets that choice. 404 when
 * the speech server is not an on-device one.
 */
import { listSpeechModels, setSpeechModelMobileData } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const result = await listSpeechModels();
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ models: result.models, mobileData: result.mobileData });
}

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as { mobileData?: unknown } | null;
	if (typeof body?.mobileData !== "boolean") return Response.json({ error: "body must be {mobileData: true | false}" }, { status: 400 });
	const result = await setSpeechModelMobileData(body.mobileData);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ models: result.models, mobileData: result.mobileData });
}
