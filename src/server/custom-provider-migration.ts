/**
 * THE CUSTOM ENDPOINTS MIGRATION (custom-endpoints wave, owner 2026-10-30):
 * upstream 0.4.0 stores one custom endpoint (`customProvider`); the fork
 * stored a list (`endpoints.list`, keys under LH_ENDPOINT_<ID>_KEY). Both
 * become entries of `customProviders`, once, from the composition root
 * (src/server/stores.ts) before any store reads them:
 *  - upstream's single endpoint keeps its binding and key and becomes the
 *    entry "custom";
 *  - each legacy endpoint keeps its id, name, thinking format and models
 *    (its per-model context / output / thinking overrides become pins, a
 *    vision override marks the model image-capable), and its key is bound
 *    to its current URL (owner Q96: it already ran against exactly that
 *    URL) — API key when a key exists, keyless otherwise.
 * Model selections name the same provider ids, so nothing else changes.
 * Idempotent: nothing to do once neither legacy section is on disk.
 */

import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { SETTINGS_FILE } from "../../config.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { customKeyVar, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { sanitizeLegacyEndpoints, type LegacyEndpoint } from "../core/endpoints.ts";
import { sanitizeUserSettings, type CustomModel, type CustomModelOverride, type CustomProviderSettings } from "../core/settings.ts";
import { readCustomAuth, writeCustomAuths } from "../store/auth.ts";
import { readSettings, writeSettings } from "../store/settings.ts";

/** The raw record on disk — the sanitizer no longer knows the legacy sections. */
function readRaw(): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
	} catch {
		return null;
	}
}

/** One legacy endpoint as a customProviders entry (no binding yet). */
export function legacyEndpointToCustomProvider(endpoint: LegacyEndpoint): CustomProviderSettings {
	const models: CustomModel[] = [];
	const overrides: Record<string, CustomModelOverride> = {};
	for (const m of endpoint.models) {
		const model: CustomModel = { id: m.id, context: m.contextWindow, maxTokens: m.maxTokens };
		if (m.overrides?.vision ?? m.vision) model.image = true;
		if (m.reasoning) model.reasoning = true;
		models.push(model);
		const pin: CustomModelOverride = {};
		if (m.overrides?.contextWindow !== undefined) pin.context = m.overrides.contextWindow;
		if (m.overrides?.maxTokens !== undefined) pin.maxTokens = m.overrides.maxTokens;
		if (m.overrides?.reasoning !== undefined) pin.reasoning = m.overrides.reasoning;
		if (Object.keys(pin).length) Object.defineProperty(overrides, m.id, { value: pin, enumerable: true, configurable: true, writable: true });
	}
	return {
		id: endpoint.id,
		name: endpoint.name,
		thinkingFormat: endpoint.thinkingFormat,
		baseUrl: endpoint.baseUrl,
		models: models.sort((a, b) => a.id.localeCompare(b.id)),
		...(Object.keys(overrides).length ? { overrides } : {}),
	};
}

export function migrateCustomEndpoints(): void {
	const raw = readRaw();
	if (!raw || (raw.endpoints === undefined && raw.customProvider === undefined)) return;
	const record = readSettings() ?? { version: 1 };
	const list = [...(record.customProviders ?? [])];
	const taken = new Set(list.map((cp) => cp.id));
	const pairs: { id: string; binding: CustomAuthBinding; fileKey: string | undefined }[] = [];

	const single = raw.customProvider;
	if (single && typeof single === "object" && !Array.isArray(single) && !taken.has(CUSTOM_PROVIDER.id)) {
		// Upstream's own record: its binding already names "custom".
		const migrated = sanitizeUserSettings({ version: record.version, customProviders: [{ ...single, id: CUSTOM_PROVIDER.id, name: CUSTOM_PROVIDER.label }] })?.customProviders?.[0];
		if (migrated?.baseUrl) {
			list.push(migrated);
			taken.add(migrated.id);
		}
	}

	const legacy = raw.endpoints && typeof raw.endpoints === "object" && !Array.isArray(raw.endpoints)
		? sanitizeLegacyEndpoints(raw.endpoints as Record<string, unknown>).list ?? []
		: [];
	for (const endpoint of legacy) {
		if (taken.has(endpoint.id)) continue;
		const fileKey = readCustomAuth(endpoint.id).fileKey()?.trim() || undefined;
		const envKey = process.env[customKeyVar(endpoint.id)]?.trim() || undefined;
		const authMode = fileKey || envKey ? "apiKey" : "keyless";
		const bindingId = randomBytes(16).toString("hex");
		pairs.push({
			id: endpoint.id,
			binding: { version: 1, id: bindingId, baseUrl: endpoint.baseUrl, authMode, ...(fileKey ? { fileKeyBaseUrl: endpoint.baseUrl } : {}) },
			fileKey,
		});
		list.push({ ...legacyEndpointToCustomProvider(endpoint), authMode, credentialBindingId: bindingId });
		taken.add(endpoint.id);
	}

	// Auth pairs FIRST, then the config naming them (custom-provider-http's
	// commit order): an interruption leaves the legacy sections on disk and
	// the next start redoes the whole migration with fresh bindings.
	if (pairs.length) writeCustomAuths(pairs);
	// The sanitizer keeps unknown top-level keys, so the legacy ones go by name.
	const { customProviders: _old, endpoints: _endpoints, customProvider: _single, ...rest } = record as typeof record & { endpoints?: unknown; customProvider?: unknown };
	writeSettings(list.length ? { ...rest, customProviders: list } : rest);
	console.info(`[settings] custom endpoints moved to customProviders: ${list.map((cp) => cp.id).join(", ") || "none"}`);
}
