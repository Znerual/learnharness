/**
 * Plugin tasks and agent sessions carry their owning device (multi-device):
 * a restart on another device must leave unfinished work of this one alone,
 * as recoverStaleJobs does for jobs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createPluginTaskRecordStore, recoverPluginTaskRecords } from "../src/store/plugin-task-records.ts";
import { createPluginAgentRecordStore } from "../src/store/plugin-agent-records.ts";
import { createPluginAgentService } from "../src/agent/plugin-agents.ts";
import { createPluginWorkerService } from "../src/agent/plugin-workers.ts";
import type { PluginTaskRecord } from "../src/core/plugin-workers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-owner-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const now = "2026-11-13T10:00:00.000Z";

function taskRecord(id: string, status: "running" | "queued", deviceId?: string): PluginTaskRecord {
	return {
		version: 1, id, definitionId: "worker", requestId: `req_${id}`, createdAt: now, updatedAt: now, status, turns: 0, maxTurns: 3,
		purpose: "background", prompt: "p", input: null, model: { provider: "faux", id: "m" },
		messages: [{ role: "user", content: "p", timestamp: 1 }], ...(deviceId ? { deviceId, deviceName: deviceId } : {}),
	} as unknown as PluginTaskRecord;
}

describe("plugin task restart sweep", () => {
	it("interrupts this device's unfinished tasks and legacy ones, never another device's", () => {
		const plugins = path.join(root, "plugins");
		const tasks = path.join(plugins, "p1", "data", "tasks");
		const store = createPluginTaskRecordStore(tasks);
		store.save(taskRecord("mine", "running", "dev_aaaaaaaa"));
		store.save(taskRecord("theirs", "running", "dev_bbbbbbbb"));
		store.save(taskRecord("legacy", "queued"));
		assert.deepEqual(recoverPluginTaskRecords(plugins, undefined, "dev_aaaaaaaa"), {});
		assert.equal(store.get("mine")!.status, "interrupted");
		assert.equal(store.get("legacy")!.status, "interrupted");
		assert.equal(store.get("theirs")!.status, "running", "another device's task is left alone");
	});
});

describe("plugin services", () => {
	const engineFor = () => { throw new Error("no model call expected"); };

	it("worker service stamps its device and leaves a foreign running task unloaded", () => {
		const store = createPluginTaskRecordStore(path.join(root, "w", "tasks"));
		store.save(taskRecord("theirs", "running", "dev_bbbbbbbb"));
		const service = createPluginWorkerService({ store, engineFor, device: () => ({ id: "dev_aaaaaaaa", name: "A" }) } as never);
		assert.equal(store.get("theirs")!.status, "running");
		void service;
	});

	it("agent service stamps its device on create and leaves a foreign running session alone", () => {
		const store = createPluginAgentRecordStore(path.join(root, "a", "agents"));
		const base = { version: 1 as const, definitionId: "agent", createdAt: now, updatedAt: now, messages: [] as never[], pending: [] as never[], acceptedInputs: [] as string[] };
		store.save({ ...base, id: "theirs", status: "running", deviceId: "dev_bbbbbbbb", deviceName: "B" });
		store.save({ ...base, id: "mine", status: "running", deviceId: "dev_aaaaaaaa", deviceName: "A" });
		const service = createPluginAgentService({ store, engineFor, device: () => ({ id: "dev_aaaaaaaa", name: "A" }) } as never);
		assert.equal(store.get("theirs")!.status, "running", "another device's session is left alone");
		assert.equal(store.get("mine")!.status, "interrupted");
		service.register({ id: "agent", instructions: "x", model: { provider: "faux", id: "m" }, tools: [] } as never);
		const created = service.create("agent");
		assert.equal(store.get(created.id)!.deviceId, "dev_aaaaaaaa");
	});
});
