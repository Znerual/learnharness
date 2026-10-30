import { graphView, GraphFormatNewerError } from "@/src/server";

/**
 * The home graph view's data endpoint (W4; vision §1 "Home page") — thin
 * transport: the server entry (src/server/graph.ts) returns nodes, edges,
 * session provenance, and per-session understanding observations.
 *
 * A graph saved by a NEWER app (multi-device: devices update at different
 * times) answers 409 {error, code: "graph_format_newer"} — the view says
 * "update this app" instead of failing.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return Response.json(graphView());
	} catch (err) {
		if (err instanceof GraphFormatNewerError) {
			return Response.json({ error: "Your knowledge graph was saved by a newer LearnHarness. Update this app to see it.", code: err.code }, { status: 409 });
		}
		throw err;
	}
}
