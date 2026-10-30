/**
 * POST /api/chats/[id]/takeover — TAKEOVER (multi-device, GLOSSARY): the
 * learner confirmed that another device's work in this session may be
 * abandoned. Clears that device's turn marker and stops its running jobs
 * here (src/server/ownership.ts takeOver).
 *
 *   POST → 200 {ok: true, jobsStopped} | 404
 */

import { getChat, takeOver } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true, ...takeOver(id) });
}
