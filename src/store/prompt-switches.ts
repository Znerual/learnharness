/**
 * The prompt-override SWITCHES (multi-device, ADR 0002):
 * prompts/switches.json in the synced data folder — the {segmentPath:
 * boolean} map that says which override files are on (absent key = off).
 * It used to be the settings record's agent.prompts; the settings store
 * (src/store/settings.ts) still presents it there, so routes, the agent
 * and the UI read and write switches exactly as before.
 */

import fs from "node:fs";
import path from "node:path";
import { PROMPT_SWITCHES_FILE } from "../../config.ts";

export function readPromptSwitches(): Record<string, boolean> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(PROMPT_SWITCHES_FILE, "utf-8"));
	} catch {
		return null; // absent or corrupt: no switches on
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(parsed)) if (typeof value === "boolean") out[key] = value;
	return out;
}

export function writePromptSwitches(switches: Record<string, boolean>): void {
	fs.mkdirSync(path.dirname(PROMPT_SWITCHES_FILE), { recursive: true });
	const tmp = `${PROMPT_SWITCHES_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(switches, null, "\t"), "utf-8");
	fs.renameSync(tmp, PROMPT_SWITCHES_FILE);
}
