/**
 * PROMPT SWITCHES SYNC WITH THEIR FILES (multi-device, ADR 0002): the
 * on/off switch of each prompt override lives in prompts/switches.json in
 * the synced data folder, beside the override files, so every device
 * teaches with the same prompts. The settings record (device-local) keeps
 * presenting them as agent.prompts, so its readers and writers stay as
 * they are. Observed through the settings store and effectivePromptSegments.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-switches-"));
const DATA = path.join(DIR, "data");
const LOCAL = path.join(DIR, "local");
process.env.LH_DATA_DIR = DATA;
process.env.LH_LOCAL_DIR = LOCAL;

const SEGMENT = "teacher/20-teaching.md";
const SWITCHES = path.join(DATA, "prompts", "switches.json");

// A pre-split install: the switch sits in the (already device-local) settings record.
fs.mkdirSync(path.join(DATA, "prompts", "teacher"), { recursive: true });
fs.writeFileSync(path.join(DATA, "prompts", "teacher", "20-teaching.md"), "custom teaching");
fs.mkdirSync(LOCAL, { recursive: true });
fs.writeFileSync(
	path.join(LOCAL, "settings.json"),
	JSON.stringify({ version: 1, agent: { tools: { research: false }, prompts: { [SEGMENT]: true } } }),
);

await import("../src/server/stores.ts"); // the composition root runs the migrations
const { settingsStore } = await import("../src/store/settings.ts");
const { effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const rawSettings = () => JSON.parse(fs.readFileSync(path.join(LOCAL, "settings.json"), "utf-8"));

test("first launch moves the switches into prompts/switches.json and out of settings.json", () => {
	assert.deepEqual(JSON.parse(fs.readFileSync(SWITCHES, "utf-8")), { [SEGMENT]: true });
	assert.equal(rawSettings().agent.prompts, undefined);
	assert.deepEqual(rawSettings().agent.tools, { research: false }, "the rest of the agent section stays");
});

test("the settings record still presents the switches as agent.prompts, and composition honors them", () => {
	const record = settingsStore.readSettings();
	assert.deepEqual(record?.agent?.prompts, { [SEGMENT]: true });
	const teaching = effectivePromptSegments("teacher", record!.agent!.prompts!).find((s) => s.path === SEGMENT);
	assert.equal(teaching?.enabled, true);
});

test("writing agent.prompts lands in switches.json, never in settings.json", () => {
	settingsStore.writeSettings({ version: 1, agent: { tools: { research: true }, prompts: {} } });
	assert.deepEqual(JSON.parse(fs.readFileSync(SWITCHES, "utf-8")), {});
	assert.equal(rawSettings().agent.prompts, undefined);
	assert.deepEqual(rawSettings().agent.tools, { research: true });
});

test("a switch synced in from another device shows up on the next read", () => {
	fs.writeFileSync(SWITCHES, JSON.stringify({ [SEGMENT]: true }));
	assert.deepEqual(settingsStore.readSettings()?.agent?.prompts, { [SEGMENT]: true });
});

test("when another device's switches arrived first, the migration merges: on in either stays on (owner, 2026-10-30)", async () => {
	const { migratePromptSwitches } = await import("../src/store/settings.ts");
	fs.writeFileSync(SWITCHES, JSON.stringify({ "teacher/30-question-principles.md": true, [SEGMENT]: false }));
	fs.writeFileSync(path.join(LOCAL, "settings.json"), JSON.stringify({ version: 1, agent: { prompts: { [SEGMENT]: true } } }));
	migratePromptSwitches();
	assert.deepEqual(JSON.parse(fs.readFileSync(SWITCHES, "utf-8")), { "teacher/30-question-principles.md": true, [SEGMENT]: true });
	assert.equal(rawSettings().agent.prompts, undefined);
});
