/**
 * GET /api/speech-benchmark — the phone's last speed check; POST — run a
 * new one (src/server/speech-models.ts speechBenchmark). 404 when the
 * speech server is not an on-device one.
 */
import { speechBenchmark } from "@/src/server";

export const dynamic = "force-dynamic";

async function benchmark(method: "GET" | "POST") {
	const call = await speechBenchmark(method);
	if (!call.ok) return Response.json({ error: call.error }, { status: call.status });
	return Response.json({ result: call.result });
}

export const GET = () => benchmark("GET");
export const POST = () => benchmark("POST");
