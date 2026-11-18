/**
 * THE "ALLOW ON THIS DEVICE" ROUTE (owner, 2026-11-18). A graded plugin question or a processed
 * practice problem that this device's agent did not ask does not run its checks here: the session
 * may have come in by sync from a device that was taken over, and the checks run plugin code on
 * the saved question (the coding questions plugin starts the program its tests name). The learner
 * allows them with this route; the id then joins the device-local list of asked questions
 * (src/store/asked-questions.ts) and the question becomes available.
 *
 * Body: { id } — the pending question's questionId or the active problem's problemId. Only an id
 * that is pending in this session right now can be allowed (400 otherwise). Nothing is written to
 * the session record, and no turn starts.
 */
import { emit } from "@/src/core";
import { allowOtherDeviceQuestion, getChat } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id: chatId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
	const chat = getChat(chatId);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (!allowOtherDeviceQuestion(chat, body?.id)) return Response.json({ error: "This question is no longer pending." }, { status: 400 });
	// Views of this session read the record again and see the question as available.
	emit("record-changed", { chatId });
	return Response.json({ ok: true });
}
