/**
 * /api/vault/* — the vault (sync, devices, history, export), behind one catch-all. The route table
 * and the request and response types are in src/core/vault/contract.ts; the handlers are in
 * src/server/vault/routes.ts. Without a vault server (LH_VAULT_URL) or without the private client
 * package every route answers 503 vault_unavailable, and GET /api/vault/available says why.
 */

import { vaultHandle } from "@/src/server";

export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
	const { path } = await ctx.params;
	const url = new URL(req.url);
	const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.json().catch(() => ({}));
	const r = await vaultHandle({ method: req.method, path: `/${path.join("/")}`, query: Object.fromEntries(url.searchParams), body });
	return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
