/**
 * The vault, as the rest of the server sees it: a request handler and an availability answer.
 * Nothing here imports the vault client (@znerual/learnharness-vault-client, packages/vault-client):
 * ./runtime.ts, the one module that imports it, is loaded with a dynamic import, so the client and
 * its WASM crypto load only when the vault is on. A load failure reports the vault as unavailable.
 *
 * The vault is off unless LH_VAULT_URL names a vault server ("vault switch").
 */

import type { RouteRequest, RouteResponse, VaultRoutes } from "./routes.ts";

export type VaultAvailability = { available: true } | { available: false; reason: "not_configured" | "package_missing" };

interface Loaded {
	routes: VaultRoutes | null;
	availability: VaultAvailability;
}

/** One load per process, on globalThis (see ./active.ts for why). */
const KEY = Symbol.for("learnharness.vault.runtime");
type Slot = { [KEY]?: Promise<Loaded> };

/** The configured vault server, or null while the vault switch is off. */
export function vaultServerUrl(): string | null {
	const url = process.env.LH_VAULT_URL?.trim();
	return url ? url.replace(/\/+$/, "") : null;
}

function load(): Promise<Loaded> {
	const slot = globalThis as Slot;
	slot[KEY] ??= (async (): Promise<Loaded> => {
		const serverUrl = vaultServerUrl();
		if (!serverUrl) return { routes: null, availability: { available: false, reason: "not_configured" } };
		try {
			const { createVaultRuntime } = await import("./runtime.ts");
			return { routes: await createVaultRuntime(serverUrl), availability: { available: true } };
		} catch (error) {
			// Only "the package is not installed" is an expected absence; anything else is a bug.
			if (!isMissingPackage(error)) console.error("[vault] the vault failed to load:", error);
			return { routes: null, availability: { available: false, reason: "package_missing" } };
		}
	})();
	return slot[KEY];
}

/** True for the module-not-found error of the vault client itself (or of its own dependencies). */
export function isMissingPackage(error: unknown): boolean {
	const e = error as { code?: string; message?: string } | null;
	return (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(e?.message ?? "")) && /learnharness-vault-client/.test(e?.message ?? "");
}

export async function vaultAvailability(): Promise<VaultAvailability> {
	return (await load()).availability;
}

/** The handler behind app/api/vault/[...path]/route.ts. */
export async function vaultHandle(req: RouteRequest): Promise<RouteResponse> {
	const { routes } = await load();
	if (req.path === "/available" && req.method.toUpperCase() === "GET") return { status: 200, body: await vaultAvailability() };
	if (!routes) return { status: 503, body: { error: "vault_unavailable", message: "The vault is not available in this build." } };
	return routes.handle(req);
}
