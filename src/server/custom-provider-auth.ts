/** Custom-only credential composition. File credentials and their authorization
 * are read from the same atomic record, never a stale fill-gapped env copy. */
import { authEnvRecord } from "../core/auth-env.ts";
import { customBindingMatches, customKeyVar, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import type { CustomProviderSettings } from "../core/settings.ts";
import { readCustomAuth, writeCustomAuth } from "../store/auth.ts";

export interface CustomAuthState {
	readable: boolean;
	binding?: CustomAuthBinding;
	key?: string;
	fileKey?: string;
	source: "env" | "file" | "none";
}
/** One custom endpoint's credential state. requiredConfig prevents even
 * credential resolution until startup/runtime authorization matches.
 * Explicit UI inspection/probe authorization omits it. */
export function customAuthState(id: string, inspectKey = false, requiredConfig?: CustomProviderSettings): CustomAuthState {
	try {
		const keyVar = customKeyVar(id);
		const snapshot = readCustomAuth(id);
		const result: CustomAuthState = { readable: true, binding: snapshot.binding, source: "none" };
		if (!inspectKey || (requiredConfig && !customBindingMatches(requiredConfig, snapshot.binding))) return result;
		result.fileKey = snapshot.fileKey();
		const record = authEnvRecord();
		const envKey = process.env.LH_IGNORE_ENV_KEYS !== "1" && record.realEnv.has(keyVar) ? process.env[keyVar] : undefined;
		result.source = envKey !== undefined ? "env" : result.fileKey !== undefined ? "file" : "none";
		result.key = (envKey ?? result.fileKey)?.trim() || undefined;
		return result;
	} catch { return { readable: false, source: "none" }; }
}
export function customKeyAuthorized(cp: CustomProviderSettings | undefined, state: CustomAuthState): boolean {
	return cp?.authMode === "apiKey" && state.readable && customBindingMatches(cp, state.binding) && Boolean(state.key) && (state.source === "env" || state.binding?.fileKeyBaseUrl === cp?.baseUrl);
}
/** Reflect only after the atomic pair is committed. Runtime file resolution
 * does not rely on this compatibility mirror, including after a failed write. */
export function persistCustomAuth(id: string, binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	writeCustomAuth(id, binding, fileKey);
	reflectCustomKey(id, fileKey);
}

/** Mirror one endpoint's file key into the process env (unless the real env owns it). */
export function reflectCustomKey(id: string, fileKey: string | undefined): void {
	const keyVar = customKeyVar(id);
	const record = authEnvRecord();
	if (!record.realEnv.has(keyVar)) {
		if (fileKey === undefined) { delete process.env[keyVar]; record.fillGap.delete(keyVar); }
		else { process.env[keyVar] = fileKey; record.fillGap.add(keyVar); }
	}
}
