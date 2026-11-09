/**
 * /api/tts/engine — the built-in voice engine, OmniVoice on this computer
 * (owner, 2026-11-09; src/server/omnivoice/).
 * GET: {status, licenses, presets}: whether this computer can run it, the
 * download's state and size, and the licenses Settings shows first.
 * POST: start the download (202; 400 {message} when this computer cannot run it).
 * DELETE: stop the engine and delete its files (204; 409 while downloading).
 */
import { OMNIVOICE_LICENSES, OMNIVOICE_PRESETS, omniVoiceRunning, omniVoiceStatus, removeOmniVoice, startOmniVoiceInstall, stopOmniVoice } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({
		status: await omniVoiceStatus(omniVoiceRunning()),
		licenses: OMNIVOICE_LICENSES,
		presets: OMNIVOICE_PRESETS.map((p) => ({ id: p.id, description: p.instruct })),
	});
}

export async function POST() {
	const started = await startOmniVoiceInstall();
	if (!started.ok) return Response.json({ message: started.error }, { status: 400 });
	return Response.json({ status: await omniVoiceStatus(omniVoiceRunning()) }, { status: 202 });
}

export async function DELETE() {
	stopOmniVoice();
	const removed = await removeOmniVoice();
	if (!removed.ok) return Response.json({ message: removed.error }, { status: 409 });
	return new Response(null, { status: 204 });
}
