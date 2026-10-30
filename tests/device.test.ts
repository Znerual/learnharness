/**
 * THE DEVICE IDENTITY (multi-device, GLOSSARY "Device"): a stable random id
 * created on first use and a learner-editable name, both device-local
 * (local/device.json — never synced).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-device-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");
delete process.env.LH_DEVICE_NAME;

const { deviceStore } = await import("../src/store/device.ts");

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("first use creates a stable id and the default name; later reads return the same device", () => {
	const first = deviceStore.getDevice();
	assert.match(first.id, /^dev_[a-z0-9]{8}$/);
	assert.equal(first.name, "Desktop");
	assert.deepEqual(deviceStore.getDevice(), first);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DIR, "local", "device.json"), "utf-8")), first);
});

test("rename trims, persists, and keeps the id; an empty name is refused", () => {
	const { id } = deviceStore.getDevice();
	assert.deepEqual(deviceStore.renameDevice("  Pixel phone "), { id, name: "Pixel phone" });
	assert.deepEqual(deviceStore.getDevice(), { id, name: "Pixel phone" });
	assert.throws(() => deviceStore.renameDevice("   "), /name/i);
	assert.equal(deviceStore.getDevice().name, "Pixel phone");
});

test("LH_DEVICE_NAME sets the default name of a new device (the Android shell passes 'Phone')", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-device-"));
	const repo = path.resolve(import.meta.dirname, "..");
	const out = execFileSync(
		process.execPath,
		["--import", path.join(repo, "node_modules", "tsx", "dist", "loader.mjs"), "--input-type=module", "--eval",
			`const { deviceStore } = await import(${JSON.stringify(path.join(repo, "src", "store", "device.ts"))}); console.log(deviceStore.getDevice().name);`],
		{ cwd: repo, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LH_DATA_DIR: path.join(dir, "data"), LH_LOCAL_DIR: path.join(dir, "local"), LH_DEVICE_NAME: "Phone" } },
	);
	assert.equal(out.trim(), "Phone");
	fs.rmSync(dir, { recursive: true, force: true });
});
