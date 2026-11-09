/**
 * DELETE /api/tts/voices/<id> — remove a voice clip ("clip-…") from the chosen
 * read-aloud engine (owner, 2026-11-09): 204, or {message} with 404 / 503 / 502.
 */
import { deleteSpeechClip } from "@/src/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Context) {
	const result = await deleteSpeechClip((await params).id);
	if (!result.ok) return Response.json({ message: result.error }, { status: result.status });
	return new Response(null, { status: 204 });
}
