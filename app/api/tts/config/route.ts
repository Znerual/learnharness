/**
 * GET /api/tts/config — read-aloud's state (read-aloud wave, 2026-10-24):
 * {ready, autoRead, speed}. `ready` = a text-to-speech URL is set (its
 * key is optional); `speed` feeds the composer's speed slider. The read-aloud player reads this at mount and after every
 * `speech` settings save.
 */
import { speechConfig } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const config = speechConfig();
	return Response.json({ ready: config.url !== null, autoRead: config.autoRead, speed: config.speed });
}
