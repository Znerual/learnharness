import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listHistoryDocuments } from "../src/server/vault/documents.ts";

test("history documents: chats and jobs by title, other files by path, no graph ledgers or markers", () => {
	const dir = mkdtempSync(join(tmpdir(), "lh-hist-docs-"));
	try {
		for (const d of ["chats", "jobs", "graph", "notes"]) mkdirSync(join(dir, d));
		writeFileSync(join(dir, "chats", "chat_a.json"), JSON.stringify({ id: "chat_a", title: "Machine learning", updatedAt: "2026-10-30T10:00:00Z" }));
		writeFileSync(join(dir, "chats", "chat_b.json"), "not json");
		writeFileSync(join(dir, "jobs", "job_1.json"), JSON.stringify({ id: "job_1", kind: "research", chatId: "chat_a", updatedAt: "2026-10-31T10:00:00Z" }));
		writeFileSync(join(dir, "graph", "nodes.jsonl"), "{}\n");
		writeFileSync(join(dir, "graph", "nodes.dev_x.jsonl"), "{}\n");
		writeFileSync(join(dir, "graph", "format.json"), "{}");
		writeFileSync(join(dir, "notes", "a.md"), "# A");
		writeFileSync(join(dir, ".stignore"), "");
		writeFileSync(join(dir, "chats", "chat_a.json.tmp-123"), "{}");
		const docs = listHistoryDocuments(dir);
		const byPath = Object.fromEntries(docs.map((d) => [d.path, d]));
		assert.deepEqual(Object.keys(byPath).sort(), ["chats/chat_a.json", "chats/chat_b.json", "graph/format.json", "jobs/job_1.json", "notes/a.md"]);
		assert.equal(byPath["chats/chat_a.json"]?.title, "Machine learning");
		assert.equal(byPath["chats/chat_b.json"]?.title, "Untitled chat");
		assert.equal(byPath["jobs/job_1.json"]?.title, 'research for "Machine learning"');
		assert.equal(byPath["jobs/job_1.json"]?.kind, "job");
		assert.equal("chatId" in (byPath["jobs/job_1.json"] ?? {}), false, "the chat id is not sent to the page");
		assert.equal(byPath["notes/a.md"]?.kind, "other");
		const order = docs.map((d) => d.path);
		assert.ok(order.indexOf("jobs/job_1.json") < order.indexOf("chats/chat_a.json"), "newest first (updatedAt, else the file time)");
		assert.deepEqual(listHistoryDocuments(join(dir, "missing")), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
