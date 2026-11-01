import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { hasVaultClient, loadIfVaultClient } from "./vault-helpers.ts";
const { eventsFor, LearnHarnessHost } = await loadIfVaultClient<typeof import("../src/server/vault/host.ts")>("../src/server/vault/host.ts");
import { assertNotSyncthing, MIGRATION_STEPS, planSyncthingMigration, SyncthingFolderError } from "../src/server/vault/syncthing.ts";
import { read, tmp } from "./vault-helpers.ts";

describe("events after applied (#40)", { skip: !hasVaultClient && "the vault client package is not installed" }, () => {
	test("maps pulled changes to the fork's existing events", () => {
		const ev = eventsFor(
			[
				{ path: "chats/chat_a.json", kind: "doc", deleted: false },
				{ path: "chats/chat_a.json", kind: "doc", deleted: false },
				{ path: "jobs/job_a.json", kind: "doc", deleted: false },
				{ path: "graph/nodes.dev_bbbbbbbb.jsonl", kind: "seg", deleted: false },
				{ path: "graph/sources.json", kind: "doc", deleted: false },
				{ path: "prompts/teacher/x.md", kind: "doc", deleted: false },
			],
			() => "chat_a",
		);
		assert.deepEqual(ev, [
			{ type: "chats-changed", payload: {} },
			{ type: "record-changed", payload: { chatId: "chat_a" } },
			{ type: "jobs-changed", payload: { chatId: "chat_a" } },
			{ type: "activity-changed", payload: {} },
			{ type: "sources-changed", payload: {} },
		]);
	});

	test("the host writes remote-mode files and emits after applied", async () => {
		const dir = tmp("host");
		const local = `${dir}-local`;
		const emitted: [string, unknown][] = [];
		const host = new LearnHarnessHost({ dataDir: dir, localDir: local, emit: (t, p) => emitted.push([t, p]) });
		await host.writeDocument("jobs/job_1.json", new TextEncoder().encode('{"chatId":"chat_9"}'));
		await host.writeDocument("chats/chat_9.json", new TextEncoder().encode("{}"));
		host.applied([
			{ path: "jobs/job_1.json", kind: "doc", deleted: false },
			{ path: "chats/chat_9.json", kind: "doc", deleted: false },
		]);
		assert.deepEqual(emitted, [
			["jobs-changed", { chatId: "chat_9" }],
			["chats-changed", {}],
			["record-changed", { chatId: "chat_9" }],
		]);
		assert.equal(read(dir, "local/vault/outbox.jsonl"), null);
	});

	test("conflict versions of a session sit beside it; other conflicts go to the device-local folder", async () => {
		const dir = tmp("host2");
		const local = `${dir}-local`;
		const host = new LearnHarnessHost({ dataDir: dir, localDir: local, emit: () => undefined });
		await host.writeConflict("chats/c.sync-conflict-20261101-101010-dev_aaaaaaaa.json", new TextEncoder().encode("mine"));
		await host.writeConflict("local/conflicts/jobs/j.json.20261101-101010", new TextEncoder().encode("job"));
		assert.equal(read(dir, "chats/c.sync-conflict-20261101-101010-dev_aaaaaaaa.json"), "mine");
		assert.equal(read(local, "conflicts/jobs/j.json.20261101-101010"), "job");
		assert.equal(new TextDecoder().decode((await host.readDocument("local/conflicts/jobs/j.json.20261101-101010")) as Uint8Array), "job");
	});

	test("a session deleted by the vault takes its conflict copies to the conflicts folder", async () => {
		const dir = tmp("host3");
		const local = `${dir}-local`;
		const host = new LearnHarnessHost({ dataDir: dir, localDir: local, emit: () => undefined });
		mkdirSync(join(dir, "chats"), { recursive: true });
		writeFileSync(join(dir, "chats/c.json"), "{}");
		writeFileSync(join(dir, "chats/c.sync-conflict-20261101-101010-dev_aaaaaaaa.json"), "{}");
		writeFileSync(join(dir, "chats/other.sync-conflict-20261101-101010-dev_aaaaaaaa.json"), "{}");
		await host.deleteDocument("chats/c.json");
		assert.equal(read(dir, "chats/c.json"), null);
		assert.equal(read(dir, "chats/c.sync-conflict-20261101-101010-dev_aaaaaaaa.json"), null);
		assert.equal(read(local, "conflicts/c.sync-conflict-20261101-101010-dev_aaaaaaaa.json"), "{}");
		assert.equal(read(dir, "chats/other.sync-conflict-20261101-101010-dev_aaaaaaaa.json"), "{}");
	});

	test("listFiles lists syncable files only", async () => {
		const dir = tmp("host4");
		const host = new LearnHarnessHost({ dataDir: dir, localDir: `${dir}-local`, emit: () => undefined });
		mkdirSync(join(dir, "chats"), { recursive: true });
		mkdirSync(join(dir, "graph"), { recursive: true });
		writeFileSync(join(dir, "chats/c.json"), "{}");
		writeFileSync(join(dir, "chats/c.json.tmp-1"), "{}");
		writeFileSync(join(dir, "graph/nodes.dev_aaaaaaaa.jsonl"), "");
		writeFileSync(join(dir, "graph/source-organization.json"), "{}");
		assert.deepEqual(await host.listFiles(), ["chats/c.json", "graph/nodes.dev_aaaaaaaa.jsonl"]);
		assert.equal((await host.listAllFiles()).length, 4);
	});
});

describe("Syncthing guard and migration plan (#41, #61)", () => {
	for (const marker of [".stfolder", ".stignore", ".stversions"]) {
		test(`${marker} makes the vault refuse the folder`, () => {
			const dir = tmp("st");
			assertNotSyncthing(dir);
			mkdirSync(join(dir, marker));
			assert.throws(() => assertNotSyncthing(dir), (e) => e instanceof SyncthingFolderError && e.code === "syncthing_folder" && /ADR 0001/.test(e.message) && e.markers[0]?.name === marker);
		});
	}

	test("a marker in an ancestor folder counts too", () => {
		const dir = tmp("st2");
		mkdirSync(join(dir, ".stfolder"));
		mkdirSync(join(dir, "data"));
		assert.throws(() => assertNotSyncthing(join(dir, "data")), SyncthingFolderError);
	});

	test("planSyncthingMigration returns the ADR steps only when markers exist", () => {
		const dir = tmp("st3");
		assert.deepEqual(planSyncthingMigration(dir), { needed: false, markers: [], steps: [] });
		mkdirSync(join(dir, ".stfolder"));
		const plan = planSyncthingMigration(dir);
		assert.ok(plan.needed);
		assert.deepEqual(plan.steps, [...MIGRATION_STEPS]);
		assert.deepEqual(plan.steps.map((s) => s.on), ["every device", "device with the most complete data", "every other device"]);
	});
});
