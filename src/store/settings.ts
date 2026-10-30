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
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, "\t"), "utf-8");
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
