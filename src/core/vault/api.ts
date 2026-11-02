// Renderer-side client for the vault routes: a typed function per route of the contract. It only
// does HTTP; there are no keys and no vault code in the renderer.

import { routeTable, type RouteErrorBody, type RouteName, type VaultContract } from "./contract.ts";

export type VaultApi = { [K in RouteName]: (req?: VaultContract[K]["req"]) => Promise<VaultContract[K]["res"]> };

export class VaultApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = "VaultApiError";
	}
}

export interface VaultApiOptions {
	/** Where the fork mounts the routes. */
	base?: string;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Fills `:name` segments from the request and returns the remaining fields. */
export function buildRequest(path: string, req: object): { path: string; rest: Record<string, unknown> } {
	const rest: Record<string, unknown> = { ...(req as Record<string, unknown>) };
	const filled = path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
		const v = rest[name];
		delete rest[name];
		return encodeURIComponent(String(v));
	});
	return { path: filled, rest };
}

export function createVaultApi(o: VaultApiOptions = {}): VaultApi {
	const base = (o.base ?? "/api/vault").replace(/\/+$/, "");
	const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
	const api = {} as Record<string, unknown>;
	for (const name of Object.keys(routeTable) as RouteName[]) {
		const { method, path } = routeTable[name];
		api[name] = async (req: object = {}) => {
			const { path: p, rest } = buildRequest(path, req);
			let url = base + p;
			let init: RequestInit = { method, headers: { accept: "application/json" } };
			if (method === "GET") {
				const q = new URLSearchParams();
				for (const [k, v] of Object.entries(rest)) if (v !== undefined) q.set(k, String(v));
				if ([...q].length) url += `?${q}`;
			} else {
				init = { ...init, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(rest) };
			}
			let res: Response;
			try {
				res = await f(url, init);
			} catch {
				throw new VaultApiError(0, "network", "Network error");
			}
			const text = await res.text();
			const json = text ? (JSON.parse(text) as unknown) : {};
			if (!res.ok) {
				const b = json as Partial<RouteErrorBody>;
				throw new VaultApiError(res.status, b.error ?? "internal", b.message ?? "Request failed");
			}
			return json;
		};
	}
	return api as VaultApi;
}

/** The stable code of any error thrown by a route call, for the view models' `failed` events. */
export function errorCode(e: unknown): string {
	return e instanceof VaultApiError ? e.code : "generic";
}
