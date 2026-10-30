import { graphView, refuseNewerGraph } from "@/src/server";

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

export const GET = refuseNewerGraph(async function get() {
	return Response.json(graphView());
});
