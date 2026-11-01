/** Synthetic authorized records, imported only after each test's isolated env. */
import { randomBytes } from "node:crypto";
import type { CustomProviderSettings } from "../../src/core/settings.ts";
import { persistCustomAuth } from "../../src/server/custom-provider-auth.ts";

/** One list entry, id "custom" unless given (keeps the upstream key/binding names). */
export type Fixture = Omit<CustomProviderSettings, "id" | "name"> & Partial<Pick<CustomProviderSettings, "id" | "name">>;

export function authorizeFixture(cp: Fixture, fileKey?: string): CustomProviderSettings {
	const bindingId = randomBytes(16).toString("hex");
	const id = cp.id ?? "custom";
	persistCustomAuth(id, { version: 1, id: bindingId, baseUrl: cp.baseUrl, authMode: cp.authMode ?? "keyless", ...(fileKey ? { fileKeyBaseUrl: cp.baseUrl } : {}) }, fileKey);
	return { ...cp, id, name: cp.name ?? "Custom endpoint", credentialBindingId: bindingId };
}
