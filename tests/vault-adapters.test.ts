import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { KeyStorage, Vault } from "@znerual/learnharness-vault-client";

import { wrapChatStore, wrapGraphStore, wrapJobStore, wrapPromptOverrideStore, wrapSettingsStore, wrapSourceOrganizationStore } from "../src/server/vault/adapters.ts";
import { hasVaultClient, loadIfVaultClient } from "./vault-helpers.ts";
const { wireVault } = await loadIfVaultClient<typeof import("../src/server/vault/wire.ts")>("../src/server/vault/wire.ts");
import { DEVICE, fakeStores, read, Recorder, tmp } from "./vault-helpers.ts";

function ctx(dir: string, rec: Recorder) {
	return { sink: rec, dataDir: dir, deviceId: () => DEVICE };
}

describe("adapters note the intent before every write", () => {
	test("sessions: every writer notes chats/<id>.json first; create notes after the id exists", () => {
		const dir = tmp("chat");
		const rec = new Recorder();
		const raw = fakeStores(dir, rec);
		const chats = wrapChatStore(raw.chatStore, ctx(dir, rec));
		const { id } = chats.createChat("Photosynthesis");
		chats.saveMessages(id, []);
		chats.saveTree(id, {});
		chats.appendTurnUsage(id, {});
		chats.appendExtractionUsage(id, {});
		chats.saveSettings(id, {});
		chats.setActiveTurn(id, null);
		chats.renameChat(id, "x");
		chats.resolveConflict(id, "current"); // changes nothing that syncs
		chats.resolveConflict(id, `${id}.sync-conflict-20261101-101010-dev_bbbbbbbb.json`);
		chats.deleteChat(id);
		const docs = rec.intents.filter((l) => l === `doc chats/${id}.json`);
		assert.equal(docs.length, 10); // create, 7 writers, resolve (keep copy), delete
		assert.equal(rec.log.filter((l) => l.startsWith("write ")).length, 10); // create (own write), 7 writers, resolve, delete
	});

	test("jobs: update and delete note first", () => {
		const dir = tmp("job");
		const rec = new Recorder();
		const jobs = wrapJobStore(fakeStores(dir, rec).jobStore, ctx(dir, rec));
		const { id } = jobs.createJob({});
		jobs.updateJob(id, { activity: "x" });
		assert.equal(jobs.deleteJobsForChat("chat_1"), 1);
		assert.deepEqual(rec.intents, [`doc jobs/${id}.json`, `doc jobs/${id}.json`, `doc jobs/${id}.json`]);
	});

	test("graph: ledger appends note the byte offset where the append begins; sources and format are documents", () => {
		const dir = tmp("graph");
		const rec = new Recorder();
		const graph = wrapGraphStore(fakeStores(dir, rec).graphStore, ctx(dir, rec));
		graph.appendNode({ id: "n1" });
		graph.appendNode({ id: "n2" });
		const first = JSON.stringify({ id: "n1" }).length + 1;
		graph.appendChain({ id: "c1" });
		graph.appendCheckpoint({});
		graph.appendCoverage({});
		graph.appendDeletion({});
		graph.upsertSource({});
		graph.deleteSources(new Set(["a"]));
		graph.appendSourceUsage("a", {});
		assert.deepEqual(rec.intents.slice(0, 3), ["doc graph/format.json", `led graph/nodes.${DEVICE}.jsonl@0`, `led graph/nodes.${DEVICE}.jsonl@${first}`]);
		assert.equal(rec.intents.filter((l) => l === "doc graph/format.json").length, 1, "format.json is noted once");
		for (const k of ["chains", "sessions", "coverage", "deletions"]) assert.ok(rec.intents.includes(`led graph/${k}.${DEVICE}.jsonl@0`), k);
		assert.equal(rec.intents.filter((l) => l === "doc graph/sources.json").length, 3);
		assert.equal(readFileSync(join(dir, `graph/nodes.${DEVICE}.jsonl`), "utf8").split("\n").length, 3);
	});

	test("prompts, switches and source organization", () => {
		const dir = tmp("prompt");
		const rec = new Recorder();
		const raw = fakeStores(dir, rec);
		const c = ctx(dir, rec);
		const prompts = wrapPromptOverrideStore(raw.promptOverrides, c);
		prompts.writeOverride("teacher/20-teaching.md", "text");
		prompts.deleteOverride("teacher/20-teaching.md");
		wrapSettingsStore(raw.settingsStore, c).writeSettings({});
		wrapSourceOrganizationStore(raw.sourceOrganizationStore, c).write({});
		assert.deepEqual(rec.intents, ["doc prompts/teacher/20-teaching.md", "doc prompts/teacher/20-teaching.md", "doc prompts/switches.json", "doc graph/format.json", "doc graph/source-organization.json"]);
	});

	test("read methods and unlisted members pass through untouched", () => {
		const dir = tmp("pass");
		const rec = new Recorder();
		const raw = fakeStores(dir, rec);
		const chats = wrapChatStore(raw.chatStore, ctx(dir, rec));
		assert.equal(chats.listConflicts, raw.chatStore.listConflicts);
	});
});

describe("wireVault", { skip: !hasVaultClient && "the vault client package is not installed" }, () => {
	function stubVault(): Vault {
		return { options: { device: { lhDeviceId: DEVICE, name: "Test" } } } as unknown as Vault;
	}

	test("wraps the stores into the real outbox and refuses a Syncthing folder", async () => {
		const dir = tmp("wire");
		const local = `${dir}-local`;
		const rec = new Recorder();
		rec.permissive = true;
		const raw = fakeStores(dir, rec);
		const emitted: string[] = [];
		const wired = wireVault({ stores: raw, dataDir: dir, localDir: local, vault: stubVault(), emit: (t) => emitted.push(t), promptOverrides: raw.promptOverrides });
		await wired.engine.init();
		const { id } = wired.stores.chatStore.createChat("A");
		wired.stores.chatStore.saveMessages(id, []);
		wired.stores.graphStore.appendNode({ id: "n" });
		assert.equal(wired.pendingCount(), 4); // create, save, format.json, ledger
		const outbox = readFileSync(join(local, "vault", "outbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		assert.deepEqual(outbox.map((e) => e["t"]), ["doc", "doc", "doc", "led"]);
		assert.equal(outbox[3]?.["f"], `graph/nodes.${DEVICE}.jsonl`);
		assert.equal(wired.stores.deviceStore, raw.deviceStore, "other members pass through");
		// reconcile notes the files again, the way the next start heals a crash in createChat
		assert.ok((await wired.reconcile()) >= 2);

		mkdirSync(join(dir, ".stfolder"));
		assert.throws(() => wireVault({ stores: raw, dataDir: dir, localDir: local, vault: stubVault(), emit: () => undefined }), /Syncthing/);
	});

	test("refuses a vault device that is not this LearnHarness device", () => {
		const dir = tmp("wire2");
		const raw = fakeStores(dir, new Recorder(), "dev_zzzzzzzz");
		assert.throws(() => wireVault({ stores: raw, dataDir: dir, vault: stubVault(), emit: () => undefined }), /not this LearnHarness device/);
	});

	for (const name of ["local", "elsewhere"]) {
		test(`leave reports pending entries, deletes <local>/vault and the secrets (local folder "${name}")`, async () => {
			const root = tmp("leave");
			const dir = join(root, "data");
			const local = join(root, name);
			const rec = new Recorder();
			rec.permissive = true;
			const raw = fakeStores(dir, rec);
			const wired = wireVault({ stores: raw, dataDir: dir, localDir: local, vault: stubVault(), emit: () => undefined });
			await wired.engine.init();
			const { id } = wired.stores.chatStore.createChat("A");
			wired.stores.chatStore.saveMessages(id, []);
			let cleared = false;
			const storage = { clear: async () => void (cleared = true) } as unknown as KeyStorage;
			writeFileSync(join(local, "keep.json"), "{}");
			const left = await wired.leave(storage);
			assert.equal(left.unpushed, 2);
			assert.equal(left.stores, raw, "plain stores are handed back");
			assert.equal(read(local, "vault/outbox.jsonl"), null);
			assert.equal(read(local, "keep.json"), "{}", "other device-local files stay");
			assert.ok(cleared, "secrets cleared");
			assert.ok(read(dir, `chats/${id}.json`), "the data folder stays a plain LearnHarness folder");
		});
	}
});
