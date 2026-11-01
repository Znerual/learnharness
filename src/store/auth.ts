/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). Ordinary reads never throw (absent/corrupt file = {} =
 * "no keys yet"); custom-only pair reads/writes below are deliberately
 * strict so an unreadable private record is never overwritten as {}.
 * Ordinary writes preserve unknown string vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { customBindingVar, customKeyVar, isCustomAuthVar, isCustomBindingVar, parseCustomAuthBinding, type CustomAuthBinding } from "../core/custom-provider-auth.ts";

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  tmp-in-same-dir + rename keeps the swap atomic; chmod BEFORE the
 *  rename so the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, unknown>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.auth.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, AUTH_FILE);
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		assertOrdinaryVar(name);
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		assertOrdinaryVar(name);
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
};

/** Custom writes must never turn an unreadable/corrupt private file into {}.
 * Other providers retain their existing adapter semantics. Unknown JSON values
 * survive custom-only updates, not just the ordinary string projection. */
function readCustomMap(): Record<string, unknown> {
	let text: string;
	try { text = fs.readFileSync(AUTH_FILE, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Custom authorization storage unavailable"); }
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { throw new Error("Custom authorization storage unavailable"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Custom authorization storage unavailable");
	const map = raw as Record<string, unknown>;
	for (const [name, value] of Object.entries(map)) {
		if (isCustomBindingVar(name) && !parseCustomAuthBinding(value)) throw new Error("Invalid custom authorization record");
		if (isCustomAuthVar(name) && !isCustomBindingVar(name) && typeof value !== "string") throw new Error("Invalid custom credential record");
	}
	return map;
}
function assertOrdinaryVar(name: string): void {
	if (isCustomAuthVar(name)) throw new Error("Use the custom endpoint editor");
}
/** One immutable file snapshot of one custom endpoint's pair. Keyless
 *  callers never invoke fileKey(). */
export function readCustomAuth(id: string) {
	const map = readCustomMap();
	return { binding: parseCustomAuthBinding(map[customBindingVar(id)]), fileKey: () => map[customKeyVar(id)] as string | undefined };
}
/** Replace just one custom endpoint's pair in ONE existing atomic record write. */
export function writeCustomAuth(id: string, binding: CustomAuthBinding | undefined, fileKey: string | undefined): void {
	writeCustomAuths([{ id, binding, fileKey }]);
}
/** Replace several custom endpoints' pairs in ONE atomic record write (the
 *  migration binds every legacy endpoint at once). */
export function writeCustomAuths(pairs: readonly { id: string; binding: CustomAuthBinding | undefined; fileKey: string | undefined }[]): void {
	const map = readCustomMap();
	for (const { id, binding, fileKey } of pairs) {
		if (binding && !parseCustomAuthBinding(JSON.stringify(binding))) throw new Error("Invalid custom authorization record");
		const keyVar = customKeyVar(id);
		const bindingVar = customBindingVar(id);
		if (fileKey === undefined) delete map[keyVar];
		else Object.defineProperty(map, keyVar, { value: fileKey, enumerable: true, configurable: true, writable: true });
		if (binding === undefined) delete map[bindingVar];
		else Object.defineProperty(map, bindingVar, { value: JSON.stringify(binding), enumerable: true, configurable: true, writable: true });
	}
	writeMap(map);
}
