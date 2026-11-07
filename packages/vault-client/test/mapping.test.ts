import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { conflictPath, isDocumentPath, parseLedgerFile } from "../src/sync/mapping.ts";

describe("parseLedgerFile", () => {
	test("base and device ledgers; the dead pre-chains ledgers are not ledgers", () => {
		assert.deepEqual(parseLedgerFile("graph/nodes.jsonl"), { ledger: "nodes", owner: "base" });
		assert.deepEqual(parseLedgerFile("graph/nodes.dev_aaaaaaaa.jsonl"), { ledger: "nodes", owner: "dev_aaaaaaaa" });
		assert.equal(parseLedgerFile("graph/edges.jsonl"), null);
		assert.equal(parseLedgerFile("graph/events.jsonl"), null);
	});
});

describe("conflictPath", () => {
	test("a session conflict name is one the LearnHarness picker reads", () => {
		const name = conflictPath("chats/chat_mvxu0vof_493e0dc4.json", "dev_x74xz870", new Date("2026-11-01T12:54:38Z"));
		assert.equal(name, "chats/chat_mvxu0vof_493e0dc4.sync-conflict-20261101-125438-devx74xz870.json");
		// conflictPattern(id) in learnharness/src/store/chats.ts, at commit 8f0e4eb
		const id = "chat_mvxu0vof_493e0dc4";
		assert.match(name.slice("chats/".length), new RegExp(`^${id}\\.sync-conflict-[A-Za-z0-9-]+\\.json$`));
	});
	test("other documents go to local/conflicts", () => {
		assert.equal(conflictPath("jobs/j.json", "dev_x74xz870", new Date("2026-11-01T12:54:38Z")), "local/conflicts/jobs/j.json.20261101-125438");
	});
});

describe("isDocumentPath", () => {
	test("prompt override files at any depth sync, temp files do not", () => {
		for (const p of ["prompts/switches.json", "prompts/system-prompt.md", "prompts/teacher/20-teaching.md", "prompts/shared/10-a.md"]) assert.ok(isDocumentPath(p), p);
		for (const p of ["prompts/switches.json.tmp-1234abcd", "prompts/teacher/x.md.tmp-1", "prompts/../chats/a.json", "local/prompts/a.md"]) assert.ok(!isDocumentPath(p), p);
	});
	test("sessions, jobs and graph documents", () => {
		for (const p of ["chats/chat_a.json", "jobs/job_a.json", "graph/sources.json", "graph/format.json"]) assert.ok(isDocumentPath(p), p);
		for (const p of ["chats/chat_a.sync-conflict-20261101-101010-dev_aaaaaaaa.json", "graph/source-organization.json", "chats/a.json.tmp-x"]) assert.ok(!isDocumentPath(p), p);
	});
});
