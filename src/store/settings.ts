/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): settings.json in the device-local folder
 * (config.SETTINGS_FILE) — read-modify-write, NOT a ledger. Non-secret
 * product preferences only; secrets stay in auth.json / .env.local.
 *
 * One section is stored elsewhere (multi-device, ADR 0002): agent.prompts,
 * the prompt-override switches, lives in the synced prompts/switches.json
 * (src/store/prompt-switches.ts). Reads overlay it onto the record and
 * writes split it off, so callers see one record as before.
 *
 * This adapter OWNS the lazy migrations:
 *  1. schema-version bumps (CURRENT_SETTINGS_VERSION) slot in here — the
 *     chain is empty today (v1 is the first shape); pure additions never
 *     bump, so an up-to-date file is always a no-op pass-through.
 *    (The legacy default-settings.json fold died with the chat section —
 *     per-session models, owner 2026-09-28.)
 *
 * Everything off disk is sanitized (core/settings.ts) before it reaches a
 * caller; everything written was already validated by the routes
 * (settings-body.ts) and is sanitized here again — the file can never hold
 * a value that would silently shift a knob.
 */

import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import {
	CURRENT_SETTINGS_VERSION,
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";
import { readPromptSwitches, writePromptSwitches } from "./prompt-switches.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { parseFileAccessSettings, type FileAccessSettingsResult } from "../core/file-access.ts";

const FILE_ACCESS_ERROR = "File-access configuration cannot be read reliably. Learner-file access is blocked. Repair File access in Settings → Agent → Tools.";

/** Separate strict view: the ordinary settings API keeps its historical
 * null/default behavior, but source access must distinguish absent prefs
 * from existing corrupt/unreadable settings. Never expose raw JSON/errors. */
function fileAccessFromRecord(raw: unknown): FileAccessSettingsResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: FILE_ACCESS_ERROR };
	const agent = (raw as Record<string, unknown>).agent;
	if (agent === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	if (!agent || typeof agent !== "object" || Array.isArray(agent)) return { ok: false, error: FILE_ACCESS_ERROR };
	const value = (agent as Record<string, unknown>).fileAccess;
	if (value === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	const parsed = parseFileAccessSettings(value);
	if (!parsed.ok || parsed.settings.folders.some((folder) => folder !== "~" && !folder.startsWith("~/") && !path.isAbsolute(folder))) {
		return { ok: false, error: FILE_ACCESS_ERROR };
	}
	return parsed;
}

/** ENOENT from a dangling settings/ancestor symlink is NOT first boot.
 * Find the nearest existing entry and verify its directory is usable. */
function settingsAreAbsent(): boolean {
	let candidate = SETTINGS_FILE;
	for (;;) {
		try { fs.lstatSync(/* turbopackIgnore: true */ candidate); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			const parent = path.dirname(candidate);
			if (parent === candidate) return false;
			candidate = parent;
			continue;
		}
		if (candidate === SETTINGS_FILE) return false;
		try {
			if (!fs.statSync(/* turbopackIgnore: true */ candidate).isDirectory()) return false;
			fs.accessSync(/* turbopackIgnore: true */ candidate, fs.constants.R_OK | fs.constants.X_OK);
			return true;
		} catch { return false; }
	}
}

export function readFileAccessSettings(): FileAccessSettingsResult {
	let raw: string;
	try { raw = fs.readFileSync(SETTINGS_FILE, "utf-8"); }
	catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" && settingsAreAbsent()
			? { ok: true, settings: { restricted: false, folders: [] } }
			: { ok: false, error: FILE_ACCESS_ERROR };
	}
	try { return fileAccessFromRecord(JSON.parse(raw)); }
	catch { return { ok: false, error: FILE_ACCESS_ERROR }; }
}

/** The record with the synced prompt switches overlaid as agent.prompts,
 *  or null when neither exists (first boot). */
export function readSettings(): UserSettings | null {
	const record = readStoredSettings();
	const switches = readPromptSwitches();
	if (!switches) return record;
	const base = record ?? { version: CURRENT_SETTINGS_VERSION };
	return { ...base, agent: { ...base.agent, prompts: switches } };
}

/** Persist the record (sanitized), routing agent.prompts to the synced
 *  switches file — the record is written whole, so absent switches mean
 *  none on. The switches file is only rewritten when it changes (it syncs).
 *  Returns what was written, switches included. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	if (!readFileAccessSettings().ok && settings.agent?.fileAccess === undefined) {
		// A whole-file corruption cannot be carried by readSettings (null).
		// Saving another preference repairs it into a BLOCKED policy unless
		// the write explicitly supplies a valid file-access preference.
		settings.agent = { ...settings.agent, fileAccess: { restricted: true, folders: [] } };
	}
	const switches = settings.agent?.prompts ?? {};
	if (JSON.stringify(switches) !== JSON.stringify(readPromptSwitches() ?? {})) writePromptSwitches(switches);
	writeStoredSettings(settings);
	return settings;
}

/** One-time split (multi-device, ADR 0002): a record that still carries
 *  agent.prompts hands them to prompts/switches.json and drops them. When
 *  another device's switches already arrived, the two merge — a switch on
 *  in either stays on (owner, 2026-10-30), so no choice is lost. */
export function migratePromptSwitches(): void {
	const record = readStoredSettings();
	const prompts = record?.agent?.prompts;
	if (!record || !prompts) return;
	const synced = readPromptSwitches() ?? {};
	const merged = { ...synced };
	for (const [segment, on] of Object.entries(prompts)) merged[segment] = (synced[segment] ?? false) || on;
	writePromptSwitches(merged);
	writeStoredSettings(record);
}

/** settings.json as stored (no switch overlay), or null when absent/corrupt.
 *  Runs the migration chain on every read — cheap: a no-op when current. */
function readStoredSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		return null; // no settings.json yet — first boot, all factory defaults
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null; // corrupt → first-boot semantics (all factory defaults)
	}
	const record = sanitizeUserSettings(parsed);
	if (!record) return null;
	if (!fileAccessFromRecord(parsed).ok) {
		// Unrelated section writes carry this safe placeholder, not a dropped
		// malformed policy that would silently restore unrestricted reads.
		record.agent = { ...record.agent, fileAccess: { restricted: true, folders: [] } };
	}
	// Version chain (empty today): a future v2 migration slots in here —
	// `if (record.version > CURRENT_SETTINGS_VERSION) …`. Unknown NEWER
	// versions pass through untouched (the sanitizer preserved unknowns).
	return record;
}

/** Writes settings.json WITHOUT agent.prompts (those live in switches.json). */
function writeStoredSettings(settings: UserSettings): void {
	let stored = settings;
	if (settings.agent && "prompts" in settings.agent) {
		const { prompts: _switches, ...agent } = settings.agent;
		stored = { ...settings, agent };
	}
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	writeFileAtomicSync(SETTINGS_FILE, JSON.stringify(stored, null, "\t"), { allowInPlaceFallback: true });
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
