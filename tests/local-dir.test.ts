/**
 * THE DEVICE-LOCAL FOLDER (multi-device, ADR 0002): settings, debug
 * recordings, graph layout and display settings, and the device identity
 * live OUTSIDE the synced data folder. Pins the path resolution (each case
 * in a fresh child process — config.ts resolves at module load) and the
 * one-time migration that moves legacy files out of the data folder.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

function inChild(env: Record<string, string>, body: string): unknown {
	const out = execFileSync(process.execPath, ["--import", TSX_LOADER, "--input-type=module", "--eval", body], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
	});
	return JSON.parse(out.trim().split("\n").at(-1)!);
}

const PRINT_PATHS = `const m = await import(${JSON.stringify(path.join(REPO_ROOT, "config.ts"))});
console.log(JSON.stringify({ local: m.PATHS.local, debug: m.PATHS.debug, settings: m.SETTINGS_FILE, positions: m.POSITIONS_FILE, render: m.RENDER_SETTINGS_FILE, device: m.DEVICE_FILE }));`;

describe("device-local folder resolution", () => {
	it("LH_LOCAL_DIR wins", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-"));
		const paths = inChild({ LH_DATA_DIR: path.join(dir, "data"), LH_LOCAL_DIR: path.join(dir, "mine") }, PRINT_PATHS) as Record<string, string>;
		assert.deepEqual(paths, {
			local: path.join(dir, "mine"),
			debug: path.join(dir, "mine", "debug"),
			settings: path.join(dir, "mine", "settings.json"),
			positions: path.join(dir, "mine", "positions.json"),
			render: path.join(dir, "mine", "render-settings.json"),
			device: path.join(dir, "mine", "device.json"),
		});
	});

	it("LH_DATA_DIR alone: a '-local' sibling named after the data folder, so data folders never share one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-"));
		const paths = inChild({ LH_DATA_DIR: path.join(dir, "lh-xyz") }, PRINT_PATHS) as Record<string, string>;
		assert.equal(paths.local, path.join(dir, "lh-xyz-local"));
		assert.equal(paths.settings, path.join(dir, "lh-xyz-local", "settings.json"));
	});

	it("neither set: <repo>/local beside <repo>/data", () => {
		const paths = inChild({}, PRINT_PATHS) as Record<string, string>;
		assert.equal(paths.local, path.join(REPO_ROOT, "local"));
		assert.equal(paths.settings, path.join(REPO_ROOT, "local", "settings.json"));
	});
});

describe("migration of legacy device-local files out of the data folder", () => {
	const MIGRATE = `const { migrateDeviceLocalData } = await import(${JSON.stringify(path.join(REPO_ROOT, "src", "store", "local-migration.ts"))});
migrateDeviceLocalData();
console.log("null");`;

	function legacyDataFolder() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
		const data = path.join(dir, "data");
		const local = path.join(dir, "local");
		fs.mkdirSync(path.join(data, "graph"), { recursive: true });
		fs.mkdirSync(path.join(data, "debug", "provider-events"), { recursive: true });
		fs.writeFileSync(path.join(data, "settings.json"), '{"version":1,"general":{"theme":"dark"}}');
		fs.writeFileSync(path.join(data, "graph", "positions.json"), '{"positions":{}}');
		fs.writeFileSync(path.join(data, "graph", "render-settings.json"), '{"labels":true}');
		fs.writeFileSync(path.join(data, "graph", "nodes.jsonl"), '{"id":"n_1"}\n');
		fs.writeFileSync(path.join(data, "debug", "provider-events", "chat_a.jsonl"), "{}\n");
		return { data, local, env: { LH_DATA_DIR: data, LH_LOCAL_DIR: local } };
	}

	it("moves settings, layout, display settings and debug recordings; leaves synced records alone", () => {
		const { data, local, env } = legacyDataFolder();
		inChild(env, MIGRATE);
		assert.equal(fs.readFileSync(path.join(local, "settings.json"), "utf-8"), '{"version":1,"general":{"theme":"dark"}}');
		assert.equal(fs.readFileSync(path.join(local, "positions.json"), "utf-8"), '{"positions":{}}');
		assert.equal(fs.readFileSync(path.join(local, "render-settings.json"), "utf-8"), '{"labels":true}');
		assert.equal(fs.readFileSync(path.join(local, "debug", "provider-events", "chat_a.jsonl"), "utf-8"), "{}\n");
		for (const gone of ["settings.json", "graph/positions.json", "graph/render-settings.json", "debug"]) {
			assert.equal(fs.existsSync(path.join(data, gone)), false, `${gone} left the data folder`);
		}
		assert.equal(fs.readFileSync(path.join(data, "graph", "nodes.jsonl"), "utf-8"), '{"id":"n_1"}\n');
	});

	it("is idempotent, and never overwrites a device-local file that already exists", () => {
		const { data, local, env } = legacyDataFolder();
		fs.mkdirSync(local, { recursive: true });
		fs.writeFileSync(path.join(local, "settings.json"), '{"version":1,"general":{"theme":"light"}}');
		inChild(env, MIGRATE);
		inChild(env, MIGRATE);
		assert.equal(fs.readFileSync(path.join(local, "settings.json"), "utf-8"), '{"version":1,"general":{"theme":"light"}}');
		assert.equal(fs.readFileSync(path.join(data, "settings.json"), "utf-8"), '{"version":1,"general":{"theme":"dark"}}', "the conflicting legacy file stays where it was");
		assert.equal(fs.readFileSync(path.join(local, "positions.json"), "utf-8"), '{"positions":{}}');
	});
});
