/**
 * GET /api/tts/config — read-aloud's state (read-aloud wave, 2026-10-24):
 * {ready, autoRead, speed, language, engine}. `ready` = a text-to-speech URL is
 * set (its key is optional), or, with the built-in engine (owner, 2026-11-09),
 * that engine is downloaded; `speed` feeds the composer's speed slider. The
 * read-aloud player reads this at mount and after every `speech` settings save.
 */
import { speechConfig, speechReady } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const config = speechConfig();
	return Response.json({ ready: await speechReady(), autoRead: config.autoRead, speed: config.speed, language: config.language, engine: config.engine });
}
