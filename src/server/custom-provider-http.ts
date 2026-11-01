/** PR #62's connect/manual-model/offline-pin workflow, with host request,
 * credential-binding and optimistic-write boundaries — per entry of the
 * `customProviders` list (custom-endpoints wave: one revision, one binding and
 * one key per endpoint id). No secret reaches GET. */
import { createHmac, randomBytes } from "node:crypto";
import { normalizeBaseUrl, parseModelIds, sanitizeCustomModelOverrides, type CustomProviderSettings, type UserSettings } from "../core/settings.ts";
import { ENDPOINT_THINKING_FORMATS, isOnOffThinkingFormat, isValidEndpointId, slugifyEndpointName, type EndpointThinkingFormat } from "../core/endpoints.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { readCustomAuth } from "../store/auth.ts";
import { customAuthState, customKeyAuthorized, persistCustomAuth } from "./custom-provider-auth.ts";
import type { CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { discoverModels, mergeManualModels, syncCustomProvider } from "./custom-provider.ts";
import { builtinProviderIds } from "../agent/models.ts";
import { parseCustomModelOverridesBody } from "./settings-body.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

const revisionKey = Symbol.for("learnharness.custom-provider-revision");
const globals = globalThis as typeof globalThis & { [revisionKey]?: Buffer };
const secret = globals[revisionKey] ??= randomBytes(32);
const failure = (error: string, status = 400) => Response.json({ error }, { status });
const stale = () => failure("Custom configuration or credentials changed. Reload configuration and retry.", 409);

const entryOf = (record: UserSettings | null, id: string) => record?.customProviders?.find((cp) => cp.id === id);

function snapshot(id: string, inspectKey = false) {
	const record = readSettings() ?? { version: 1 };
	const cp = entryOf(record, id);
	// Keyless never looks up a key for authentication or revision generation.
	// An explicit API-key inspection is used only after the user selects that mode.
	const auth = customAuthState(id, inspectKey);
	const key = auth.key;
	// Public revisions contain configuration only, never credential material.
	// Effective credentials are compared privately across the awaited probe.
	const etag = `"${createHmac("sha256", secret).update(JSON.stringify([id, cp ?? null, auth.binding ?? null, auth.readable])).digest("base64url")}"`;
	return { record, cp, auth, key, etag };
}

function response(id: string, body: object) {
	return Response.json(body, { headers: { etag: snapshot(id).etag, "cache-control": "no-store" } });
}

/** One endpoint's non-secret status; `revision` repeats the ETag for list readers. */
function status(id: string, inspect: boolean) {
	const current = snapshot(id);
	const s = snapshot(id, inspect || current.cp?.authMode === "apiKey");
	return {
		id, name: s.cp?.name ?? "", thinkingFormat: s.cp?.thinkingFormat ?? "openai",
		baseUrl: s.cp?.baseUrl ?? "", authMode: s.cp?.authMode ?? "keyless",
		models: s.cp?.models ?? [], overrides: s.cp?.overrides ?? {}, manualModels: s.cp?.manualModels ?? [],
		keyPresent: Boolean(s.key), keySource: s.auth.source,
		keyReuseRequired: Boolean(s.key) && !customKeyAuthorized(s.cp, s.auth),
		revision: current.etag,
	};
}

/** GET /api/custom-providers — every endpoint's status, in stored order. */
export function customProvidersList(): Response {
	const ids = (readSettings()?.customProviders ?? []).map((cp) => cp.id);
	return Response.json({ providers: ids.map((id) => status(id, false)) }, { headers: { "cache-control": "no-store" } });
}

/** GET /api/custom-providers/[id]. */
export function customProviderGet(request: Request, id: string): Response {
	if (!entryOf(readSettings(), id)) return failure("No such custom endpoint", 404);
	const inspect = new URL(request.url).searchParams.get("authMode") === "apiKey";
	return response(id, status(id, inspect));
}

function authorized(request: Request): boolean {
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	if (desktop) return desktopAPIAuthorized(request.headers);
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	try {
		// Next's standalone Request URL can use its internal hostname. Match
		// the actual addressed Host through the app's existing origin seam;
		// never trust forwarded-origin headers.
		return origin === subscriptionRequestOrigin(request)
			&& (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	} catch { return false; }
}

/** Auth pair FIRST, matching config nonce SECOND. Any interrupted/failed
 * cross-file publication is durably unusable, including with a real env key.
 * Best-effort rollback restores the entire old pair, never just its secret.
 * `cp` undefined removes the entry; otherwise it replaces the entry of the
 * same id in place, or joins the end of the list. */
function commit(id: string, cp: CustomProviderSettings | undefined, binding?: CustomAuthBinding, fileKey?: string): void {
	const latest = readSettings() ?? { version: 1 };
	const oldAuth = binding ? readCustomAuth(id) : undefined;
	let published = false;
	try {
		if (binding) { persistCustomAuth(id, binding, fileKey); published = true; }
		const list = latest.customProviders ?? [];
		const next = cp
			? list.some((entry) => entry.id === id) ? list.map((entry) => entry.id === id ? cp : entry) : [...list, cp]
			: list.filter((entry) => entry.id !== id);
		const { customProviders: _old, ...rest } = latest;
		writeSettings(next.length ? { ...rest, customProviders: next } : rest);
	} catch {
		if (published && oldAuth) {
			try { persistCustomAuth(id, oldAuth.binding, oldAuth.fileKey()); } catch { /* durable nonce mismatch fails closed after restart */ }
		}
		throw new Error("Unable to save custom configuration. Reload configuration and retry.");
	}
	syncCustomProvider();
}

function thinkingFormatOf(raw: unknown): EndpointThinkingFormat | null | undefined {
	if (raw === undefined) return undefined;
	return (ENDPOINT_THINKING_FORMATS as readonly unknown[]).includes(raw) ? raw as EndpointThinkingFormat : null;
}

function nameOf(raw: unknown): string | null | undefined {
	if (raw === undefined) return undefined;
	return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 80) : null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
	if (!authorized(request)) return failure("Custom configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("JSON content-type is required.", 415);
	// Next can represent an empty DELETE as a zero-byte stream rather
	// than null. Bound it either way; only DELETE permits an empty body.
	const body = await readBoundedJson(request, 64 * 1024, request.method === "DELETE");
	if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body");
	return body as Record<string, unknown>;
}

function caught(error: unknown): Response {
	return failure(error instanceof CustomBodyLimitError ? "Configuration body exceeds 64 KiB." : error instanceof SyntaxError ? "Invalid JSON body." : "Unable to save custom configuration. Reload configuration and retry.", error instanceof CustomBodyLimitError ? 413 : error instanceof SyntaxError ? 400 : 500);
}

/** POST /api/custom-providers — add an endpoint: its id comes from its name. */
export async function customProviderCreate(request: Request): Promise<Response> {
	try {
		const raw = await readBody(request);
		if (raw instanceof Response) return raw;
		const name = nameOf(raw.name);
		if (!name) return failure("Name the endpoint.");
		const id = slugifyEndpointName(name);
		if (!isValidEndpointId(id)) return failure("The name must contain letters or digits.");
		if (builtinProviderIds().has(id)) return failure(`"${id}" is a built-in provider — choose another name.`);
		if (entryOf(readSettings(), id)) return failure(`An endpoint named "${id}" already exists.`, 409);
		return await connect(raw, id, name, snapshot(id, raw.authMode === "apiKey"));
	} catch (error) {
		return caught(error);
	}
}

/** POST/PATCH/DELETE /api/custom-providers/[id]. */
export async function customProviderMutation(request: Request, id: string): Promise<Response> {
	try {
		const raw = await readBody(request);
		if (raw instanceof Response) return raw;
		const before = snapshot(id, raw.authMode === "apiKey");
		if (!before.auth.readable) return failure("Custom authorization storage is unavailable. No changes were saved.", 500);
		if (request.headers.get("if-match") !== before.etag) return stale();
		if (!before.cp) return failure("No such custom endpoint", 404);
		if (request.method === "DELETE") {
			commit(id, undefined, { version: 1, id: randomBytes(16).toString("hex"), authMode: "disabled" });
			return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
		}
		if (request.method === "PATCH") {
			// Offline edits — no probe: the per-model pins, the thinking format, the name.
			const next: CustomProviderSettings = { ...before.cp };
			if (raw.overrides !== undefined) {
				const parsed = parseCustomModelOverridesBody(raw);
				if (!parsed.ok) return failure(parsed.error);
				next.overrides = sanitizeCustomModelOverrides(parsed.settings, before.cp.models?.map((m) => m.id));
			}
			const thinkingFormat = thinkingFormatOf(raw.thinkingFormat);
			if (thinkingFormat === null) return failure(`thinkingFormat must be one of ${ENDPOINT_THINKING_FORMATS.join(", ")}`);
			if (thinkingFormat) next.thinkingFormat = thinkingFormat;
			const name = nameOf(raw.name);
			if (name === null) return failure("Name the endpoint.");
			if (name) next.name = name;
			commit(id, next);
			return response(id, { ok: true, overrides: next.overrides ?? {} });
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		return await connect(raw, id, nameOf(raw.name) ?? before.cp.name, before);
	} catch (error) {
		return caught(error);
	}
}

/** The connect: validate, discover, then publish key + config for `id`.
 * `before` is the entry's snapshot (no entry yet for a create). */
async function connect(raw: Record<string, unknown>, id: string, name: string | null, before: ReturnType<typeof snapshot>): Promise<Response> {
	if (!name) return failure("Name the endpoint.");
	if (!before.auth.readable) return failure("Custom authorization storage is unavailable. No changes were saved.", 500);
	const base = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
	if (!base) return failure("Base URL must be http(s), with no credentials, query or fragment.");
	if (raw.authMode !== "keyless" && raw.authMode !== "apiKey") return failure("Choose Keyless or API key authentication.");
	const authMode = raw.authMode;
	const thinkingFormat = thinkingFormatOf(raw.thinkingFormat);
	if (thinkingFormat === null) return failure(`thinkingFormat must be one of ${ENDPOINT_THINKING_FORMATS.join(", ")}`);
	const format = thinkingFormat ?? before.cp?.thinkingFormat;
	if (raw.key !== undefined && typeof raw.key !== "string") return failure("API key must be a string.");
	const supplied = typeof raw.key === "string" ? raw.key.trim() : undefined;
	if (authMode === "apiKey" && supplied === "") return failure("Choose Keyless to clear authentication.");
	const envOwned = before.auth.source === "env";
	if (envOwned && supplied) return failure("Environment owns the effective key. Change the environment or explicitly reuse that key.");
	// A shadowed file key is not the key that will run. Require consent for
	// the actual environment key when authorizing a different endpoint.
	const hasNewEffectiveKey = Boolean(supplied) && !envOwned;
	const changedTarget = before.cp?.baseUrl !== base;
	if (authMode === "apiKey" && (changedTarget || !customKeyAuthorized(before.cp, before.auth)) && !hasNewEffectiveKey && raw.reuseKey !== true) {
		return failure("Enter a new key or explicitly allow reuse of the effective existing key for this URL.");
	}
	const effectiveKey = authMode === "apiKey" ? (envOwned ? before.key : supplied || before.key) : undefined;
	if (authMode === "apiKey" && !effectiveKey) return failure("API key mode requires an effective key.");
	const manualModels = parseModelIds(raw.manualModels);
	if (manualModels.length > 10_000) return failure("Model list exceeds 10000 entries");
	const found = await discoverModels(base, effectiveKey, { assumeReasoning: isOnOffThinkingFormat(format) });
	if (!found.ok && (found.fatal || found.status === 401 || found.status === 403)) return failure(found.error, 502);
	if (!found.ok && !manualModels.length) return failure(`${found.error}. If this endpoint has no /models list, add model IDs manually.`, 502);
	// Discovery yields; both the custom record and the credential must still
	// match. Unrelated settings edits are preserved by commit's fresh merge.
	const now = snapshot(id, authMode === "apiKey");
	if (before.etag !== now.etag || JSON.stringify(before.auth) !== JSON.stringify(now.auth)) return stale();
	const discovered = found.ok ? found.models : !changedTarget ? before.cp?.models ?? [] : [];
	const models = mergeManualModels(discovered, manualModels);
	if (models.length > 10_000) return failure("Model list exceeds 10000 entries");
	const overrides = sanitizeCustomModelOverrides(!changedTarget ? before.cp?.overrides : undefined, models.map((m) => m.id));
	const bindingId = randomBytes(16).toString("hex");
	const fileKey = authMode === "keyless" ? undefined : supplied && !envOwned ? supplied : now.auth.fileKey;
	const fileKeyBaseUrl = authMode === "apiKey" ? envOwned ? now.auth.binding?.fileKeyBaseUrl : base : undefined;
	const binding: CustomAuthBinding = { version: 1, id: bindingId, baseUrl: base, authMode, ...(fileKey && fileKeyBaseUrl ? { fileKeyBaseUrl } : {}) };
	commit(id, {
		id, name, ...(format ? { thinkingFormat: format } : {}),
		baseUrl: base, authMode, credentialBindingId: bindingId, models, overrides, ...(manualModels.length ? { manualModels } : {}),
	}, binding, fileKey);
	return response(id, { ok: true, id, models });
}
