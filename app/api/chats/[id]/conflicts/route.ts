/**
 * POST /api/chats/[id]/conflicts — resolve a conflict copy (multi-device,
 * GLOSSARY "Conflict copy"): the learner keeps one version of a session
 * two devices changed before syncing. The others move to the device-local
 * conflicts folder — recoverable by hand, never deleted.
 *
 *   Body: {keep: "current" | "<conflict copy file name>"}
 *   POST → 200 {ok: true} | 400 {error} | 404
 */

import { getChat, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { keep?: unknown } | null;
	if (typeof body?.keep !== "string" || !stores.chatStore.resolveConflict(id, body.keep)) {
		return Response.json({ error: 'keep must be "current" or the file name of one of this session\'s conflict copies' }, { status: 400 });
	}
	return Response.json({ ok: true });
}
