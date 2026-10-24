/**
 * GET /api/stt/config — which dictation engine runs (local-STT wave,
 * 2026-10-24): {engine, ready}. `ready` = the engine has what it needs to
 * start (Deepgram: its key; Local: a URL — its key is optional). The
 * dictation hook reads this before every run.
 */
import { dictationConfig, keyValue } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const config = dictationConfig();
	const ready = config.engine === "local" ? config.localUrl !== null : keyValue("DEEPGRAM_API_KEY") !== undefined;
	return Response.json({ engine: config.engine, ready });
}
