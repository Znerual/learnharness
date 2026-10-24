/**
 * POST /api/endpoints/detect — ask a custom OpenAI-compatible endpoint
 * which models it serves (custom-endpoints wave, 2026-10-24).
 *
 * Body {baseUrl, apiKey?, endpointId?}: apiKey is the freshly pasted key;
 * endpointId lets an edit reuse the stored key without retyping it.
 * 200 {models} — the detected list for the Keys section's endpoint
 * editor, which persists it through PUT /api/settings/endpoints. 400 bad
 * body; 502 when the endpoint is unreachable, refuses the key, or lists
 * no chat models (the error line is shown inline as-is).
 */
import { detectEndpointModels } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.baseUrl !== "string") {
		return Response.json({ error: "body must be {baseUrl: string, apiKey?: string, endpointId?: string}" }, { status: 400 });
	}
	const result = await detectEndpointModels({
		baseUrl: body.baseUrl,
		apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
		endpointId: typeof body.endpointId === "string" ? body.endpointId : undefined,
	});
	if (!result.ok) return Response.json({ error: result.error }, { status: 502 });
	return Response.json({ models: result.models });
}
