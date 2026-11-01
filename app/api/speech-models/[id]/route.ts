/**
 * POST /api/speech-models/[id] — download one on-device speech model;
 * DELETE — remove it. Both answer the new list (src/server/speech-models.ts).
 */
import { changeSpeechModel } from "@/src/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function change(method: "POST" | "DELETE", { params }: Context) {
	const result = await changeSpeechModel((await params).id, method);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ models: result.models });
}

export const POST = (_request: Request, context: Context) => change("POST", context);
export const DELETE = (_request: Request, context: Context) => change("DELETE", context);
