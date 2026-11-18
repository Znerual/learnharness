// Plugin data sync, app side (ADR 0007): manifest sync.exclude, the plugin host's withStopped,
// and the PluginFilesHost in src/server/vault/plugin-sync.ts (scanner, safe writes, conflicts).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { isSyncExcluded, parsePluginManifest, type PluginInfo, type PluginLearningData, type PluginInference } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";
import { createPluginHost } from "../src/server/plugin-host.ts";
import { hasVaultClient, loadIfVaultClient } from "./vault-helpers.ts";

const manifest = (extra: Record<string, unknown> = {}) => ({ apiVersion: 1, id: "notes", name: "Notes", version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs", ...extra });

test("manifest sync.exclude is validated and matches folders and globs", () => {
	assert.deepEqual(parsePluginManifest(manifest({ sync: { exclude: ["test-runs/", "cache/*.json"] } }), "notes", "1.0.0").sync, { exclude: ["test-runs/", "cache/*.json"] });
	assert.equal(parsePluginManifest(manifest(), "notes", "1.0.0").sync, undefined);
	for (const bad of [{ exclude: "x" }, { exclude: ["../x"] }, { exclude: ["/abs"] }, { exclude: ["a b"] }, [], { exclude: Array(33).fill("a") }]) {
		assert.throws(() => parsePluginManifest(manifest({ sync: bad }), "notes", "1.0.0"), /sync\.exclude/, JSON.stringify(bad));
	}
	assert.equal(isSyncExcluded("test-runs/q/attempt/answer.txt", ["test-runs/"]), true);
	assert.equal(isSyncExcluded("test-runs.json", ["test-runs/"]), false);
	assert.equal(isSyncExcluded("cache/a.json", ["cache/*.json"]), true);
	assert.equal(isSyncExcluded("cache/a.md", ["cache/*.json"]), false);
	assert.equal(isSyncExcluded("x.v1.json", ["x.v1.json"]), true);
	assert.equal(isSyncExcluded("xav1.json", ["x.v1.json"]), false, "a dot is literal");
});

function hostFixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sync-host-"));
	const directory = path.join(root, "plugins");
	fs.mkdirSync(directory);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const history: string[] = [];
	const host = createPluginHost({
		directory, appVersion: "1.0.0",
		createServices() {
			return { learning: {} as PluginLearningData, inference: {} as PluginInference,
				agents: { dispose: async () => undefined } as PluginAgentService,
				workers: { dispose: async () => undefined } as PluginWorkerService,
				createBackgroundTool() { throw new Error("unexpected"); } };
		},
	});
	t.after(() => host.dispose());
	const dist = path.join(directory, "notes", "dist");
	fs.mkdirSync(dist, { recursive: true });
	fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest()));
	// The backend reads its data once at activation, like Flashcards, and has a slow operation.
	fs.writeFileSync(path.join(dist, "backend.cjs"), `
		const fs = require("node:fs"), path = require("node:path");
		exports.activate = ctx => {
			const file = path.join(ctx.dataDirectory, "state.json");
			const state = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "none";
			globalThis.__pluginSyncHistory.push("activate:" + state);
			ctx.handle("read", () => state);
			ctx.handle("slow", () => new Promise(r => setTimeout(() => r("done"), 150)));
			if (state.includes("refuse")) throw new Error("refused data");
			return () => { globalThis.__pluginSyncHistory.push("cleanup"); };
		};`);
	(globalThis as { __pluginSyncHistory?: string[] }).__pluginSyncHistory = history;
	return { root, directory, host, history, dataDir: path.join(directory, "notes", "data") };
}

test("withStopped stops a running plugin, runs the change, restarts it and bumps dataGeneration", async t => {
	const { host, history, dataDir } = hostFixture(t);
	await host.initialize();
	await host.setEnabled("notes", true);
	assert.equal(await host.call("notes", "read", undefined), "none");
	fs.mkdirSync(dataDir, { recursive: true });
	const ok = await host.withStopped("notes", async () => { fs.writeFileSync(path.join(dataDir, "state.json"), "synced"); });
	assert.equal(ok, true);
	assert.equal(await host.call("notes", "read", undefined), "synced", "the restarted backend read the new file");
	assert.deepEqual(history, ["activate:none", "cleanup", "activate:synced"]);
	assert.equal(host.list().find(p => p.id === "notes")?.dataGeneration, 1);

	// A running operation is waited for; live work answers busy without running the change.
	const slow = host.call("notes", "slow", undefined);
	const stopped = host.withStopped("notes", async () => { history.push("changed"); });
	assert.equal(await slow, "done");
	assert.equal(await stopped, true);
	assert.equal(history.at(-2), "changed");
	assert.equal(await host.withStopped("notes", async () => { history.push("never"); }, { isBusy: () => true }), "busy");
	assert.ok(!history.includes("never"));

	// A plugin that refuses its new data reports false.
	assert.equal(await host.withStopped("notes", async () => { fs.writeFileSync(path.join(dataDir, "state.json"), "refuse"); }), false);
	assert.equal(host.list().find(p => p.id === "notes")?.status, "error");

	// A plugin that is not running gets the change directly.
	await host.setEnabled("notes", false);
	const before = history.length;
	assert.equal(await host.withStopped("notes", async () => { history.push("direct"); }), true);
	assert.deepEqual(history.slice(before), ["direct"]);
});

test("ctx.localDataDirectory is a per-plugin folder outside the synced data", async t => {
	const { host, root, directory } = hostFixture(t);
	fs.writeFileSync(path.join(directory, "notes", "dist", "backend.cjs"), `
		const fs = require("node:fs"), path = require("node:path");
		exports.activate = ctx => { ctx.handle("dirs", () => ({ data: ctx.dataDirectory, local: ctx.localDataDirectory, exists: fs.statSync(ctx.localDataDirectory).isDirectory() })); };`);
	await host.initialize();
	await host.setEnabled("notes", true);
	const dirs = await host.call("notes", "dirs", undefined) as { data: string; local: string; exists: boolean };
	assert.equal(dirs.local, path.join(root, "plugin-local", "notes"));
	assert.equal(dirs.exists, true);
	assert.ok(!dirs.local.startsWith(dirs.data), "never inside the synced data folder");
});

test("the PluginFilesHost lists, reads and writes plugin files safely", { skip: !hasVaultClient && "the vault client package is not installed" }, async t => {
	const { createPluginSync, checkPluginFileContent } = await loadIfVaultClient<typeof import("../src/server/vault/plugin-sync.ts")>("../src/server/vault/plugin-sync.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sync-files-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const pluginDirectory = path.join(root, "local", "plugins");
	const coreDir = path.join(root, "data", "core-plugin-data");
	const data = path.join(coreDir, "flashcards");
	fs.mkdirSync(path.join(data, "sources"), { recursive: true });
	fs.mkdirSync(path.join(data, "test-runs", "q1"), { recursive: true });
	fs.mkdirSync(path.join(data, "a", "b", "c"), { recursive: true });
	fs.mkdirSync(pluginDirectory, { recursive: true });
	fs.writeFileSync(path.join(data, "flashcards.json"), "{}");
	fs.writeFileSync(path.join(data, "sources", "s1.md"), "# s\n");
	fs.writeFileSync(path.join(data, ".hidden.json"), "{}");
	fs.writeFileSync(path.join(data, "flashcards.json.123.tmp"), "{}");
	fs.writeFileSync(path.join(data, "code.js"), "alert(1)");
	fs.writeFileSync(path.join(data, "test-runs", "q1", "out.txt"), "x");
	fs.writeFileSync(path.join(data, "a", "b", "c", "too-deep.json"), "{}");
	fs.symlinkSync(path.join(data, "flashcards.json"), path.join(data, "link.json"));
	const info: PluginInfo = { id: "flashcards", origin: "core", enabled: true, status: "active", revision: "r", manifest: { ...parsePluginManifest({ ...manifest({ id: "flashcards", name: "Flashcards" }), sync: { exclude: ["test-runs/"] } }, "flashcards", "1.0.0") } };
	const stops: string[] = [];
	const notified: string[] = [];
	const sync = createPluginSync({
		getHost: async () => ({ list: () => [info], withStopped: async (id, fn) => { stops.push(id); await fn(); return true; } }),
		pluginDirectory, core: { directory: coreDir, ids: ["flashcards"] }, localDir: path.join(root, "local"),
		engine: () => null, hasLiveWork: () => false, notify: id => notified.push(id), now: () => new Date("2026-11-18T12:00:00Z"),
	});
	const p = { origin: "core" as const, id: "flashcards" };
	assert.deepEqual((await sync.filesHost.activePlugins()).map(a => a.id), ["flashcards"]);
	assert.deepEqual((await sync.filesHost.listPluginFiles(p)).map(f => f.rel), ["flashcards.json", "sources/s1.md"]);
	assert.equal(new TextDecoder().decode((await sync.filesHost.readPluginFile(p, "sources/s1.md")) as Uint8Array), "# s\n");
	assert.equal(await sync.filesHost.readPluginFile(p, "missing.json"), null);
	await assert.rejects(() => sync.filesHost.readPluginFile(p, "../escape.json"), /not a syncable/);

	const enc = new TextEncoder();
	assert.equal(await sync.filesHost.withPluginStopped(p, async io => {
		await io.write("sources/new.md", enc.encode("new\n"));
		await io.write("deep/er/x.jsonl", enc.encode('{"a":1}\n'));
		await assert.rejects(() => io.write("bad.json", enc.encode("{")), /JSON/);
		await assert.rejects(() => io.write("../../x.json", enc.encode("{}")), /not a syncable/);
		await assert.rejects(() => io.write("run.js", enc.encode("1")), /not a syncable/);
		await assert.rejects(() => io.write("pic.png", enc.encode("not png")), /PNG/);
		await io.remove("sources/s1.md");
	}), true);
	assert.equal(fs.readFileSync(path.join(data, "sources", "new.md"), "utf8"), "new\n");
	assert.equal(fs.existsSync(path.join(data, "sources", "s1.md")), false);
	assert.deepEqual(stops, ["flashcards"]);
	assert.deepEqual(notified, ["flashcards"]);
	assert.ok(!fs.readdirSync(data).some(n => n.includes(".sync.tmp")), "no temporary file is left");

	// A symlinked folder on the way is refused.
	fs.symlinkSync(os.tmpdir(), path.join(data, "outside"));
	await assert.rejects(() => sync.filesHost.withPluginStopped(p, io => io.write("outside/x.json", enc.encode("{}"))), /unsafe/);

	await sync.filesHost.writePluginConflict(p, "flashcards.json", enc.encode('{"mine":1}'));
	await sync.filesHost.writePluginConflict(p, "flashcards.json", enc.encode('{"mine":2}'));
	const conflicts = fs.readdirSync(path.join(root, "local", "conflicts", "plugins", "core", "flashcards")).sort();
	assert.deepEqual(conflicts, ["flashcards.json.20261118-120000", "flashcards.json.20261118-120000-1"]);

	assert.doesNotThrow(() => checkPluginFileContent("a.webp", Uint8Array.from([...enc.encode("RIFF"), 0, 0, 0, 0, ...enc.encode("WEBP")])));
	assert.throws(() => checkPluginFileContent("a.txt", Uint8Array.from([0xff, 0xfe])));
});
