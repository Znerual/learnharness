/**
 * POST → stop a running side answer (inline side questions, 2026-11-02).
 * The partial answer is saved with `stopped: true`. 409 when nothing runs.
 */
import { foreignOwner, ownedElsewhereResponse, sideChats } from "@/src/server";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; threadId: string }> }): Promise<Response> {
	const { id, threadId } = await ctx.params;
	// Multi-device: another device owns this session's running work — read-only here.
	const owner = foreignOwner(id);
	if (owner) return ownedElsewhereResponse(owner);
	if (!sideChats.stop(id, threadId)) return Response.json({ error: "No side answer is running" }, { status: 409 });
	return Response.json({ ok: true });
}
