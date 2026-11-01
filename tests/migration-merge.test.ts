/**
 * Merging a second device's moved-aside data into the vault's copy (src/server/migration/merge.ts):
 * what is added, what is kept, what becomes a conflict copy, and that a second run changes nothing.
 * The "vault" side is a fixture folder (what the join downloaded); the other side is derived from it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import { listMovedAside, mergePreVault } from "../src/server/migration/merge.ts";
import { copyFixture, digest, files, json, read } from "./helpers/migration-fixtures.ts";

const PHONE = "dev_phone001";

function setup() {
	const live = copyFixture("v0.4.2001");
	const from = path.join(live.localDir, "pre-vault-20261101");
	fs.cpSync(live.dataDir, from, { recursive: true });
	const calls: string[] = [];
	const sink = {
		noteDocumentChanged: async (p: string) => void calls.push(`doc ${p}`),
		noteLedgerAppended: async (f: string, o: number) => void calls.push(`ledger ${f}@${o}`),
	};
	const ids = files(path.join(live.dataDir, "chats")).map((f) => f.replace(/\.json$/, ""));
	return { ...live, from, sink, calls, ids, run: () => mergePreVault({ dataDir: live.dataDir, localDir: live.localDir, fromDir: from, deviceId: PHONE, sink, now: () => new Date("2026-11-01T15:30:00Z") }) };
}

const msg = (text: string) => ({ role: "user", content: text, timestamp: 5 });
const edit = (file: string, f: (r: any) => any) => fs.writeFileSync(file, JSON.stringify(f(JSON.parse(fs.readFileSync(file, "utf-8"))), null, "\t"));

describe("merging moved-aside data into the vault", () => {
	test("identical data changes nothing", async () => {
		const s = setup();
		const before = digest(s.dataDir);
		const r = await s.run();
		assert.deepEqual(digest(s.dataDir), before);
		assert.deepEqual(s.calls, []);
		assert.equal(r.sessions.identical, 2);
		assert.equal(r.sessions.added + r.sessions.continued + r.sessions.conflictCopies, 0);
	});

	test("sessions: added, continued, kept and conflict copies", async () => {
		const s = setup();
		const [a, b] = s.ids as [string, string];
		// a: this device continued it; b: diverged from the vault's copy
		edit(path.join(s.from, "chats", `${a}.json`), (r) => ({ ...r, messages: [...r.messages, msg("only here")] }));
		edit(path.join(s.from, "chats", `${b}.json`), (r) => ({ ...r, messages: [...r.messages, msg("phone answer")] }));
		edit(path.join(s.dataDir, "chats", `${b}.json`), (r) => ({ ...r, messages: [...r.messages, msg("desktop answer")] }));
		// c: only on this device, with a job, and an orphan job of a session that is nowhere
		const record = json(s.from, "chats", `${a}.json`);
		fs.writeFileSync(path.join(s.from, "chats", "chat_new_phone.json"), JSON.stringify({ ...record, id: "chat_new_phone", title: "Phone only" }, null, "\t"));
		fs.writeFileSync(path.join(s.from, "jobs", "job_phone_1.json"), JSON.stringify({ id: "job_phone_1", kind: "research", chatId: "chat_new_phone", toolCallId: "t", status: "done" }, null, "\t"));
		fs.writeFileSync(path.join(s.from, "jobs", "job_orphan_1.json"), JSON.stringify({ id: "job_orphan_1", kind: "research", chatId: "chat_gone", toolCallId: "t", status: "done" }, null, "\t"));

		const r = await s.run();
		assert.deepEqual(r.sessions, { added: 1, continued: 1, identical: 0, keptVault: 0, conflictCopies: 1 });
		assert.equal(json(s.dataDir, "chats", `${a}.json`).messages.at(-1).content, "only here");
		assert.equal(json(s.dataDir, "chats", "chat_new_phone.json").title, "Phone only");
		assert.equal(json(s.dataDir, "jobs", "job_phone_1.json").chatId, "chat_new_phone");
		assert.equal(r.jobs.added, 1);
		assert.equal(r.jobs.skipped, 1);
		assert.ok(!fs.existsSync(path.join(s.dataDir, "jobs", "job_orphan_1.json")));
		// b stays as the vault has it, and this device's version sits beside it under the name the conflict picker reads
		assert.equal(json(s.dataDir, "chats", `${b}.json`).messages.at(-1).content, "desktop answer");
		const copy = files(path.join(s.dataDir, "chats")).find((f) => f.startsWith(`${b}.sync-conflict-`)) as string;
		assert.match(copy, new RegExp(`^${b}\\.sync-conflict-[A-Za-z0-9-]+\\.json$`));
		assert.equal(json(s.dataDir, "chats", copy).messages.at(-1).content, "phone answer");
		// every synced write noted its intent first
		assert.deepEqual(s.calls.filter((c) => c.startsWith("doc ")).sort(), [`doc chats/${a}.json`, "doc chats/chat_new_phone.json", "doc jobs/job_phone_1.json"].sort());

		// the second run is a no-op
		const settled = digest(s.dataDir);
		s.calls.length = 0;
		const again = await s.run();
		assert.deepEqual(digest(s.dataDir), settled);
		assert.deepEqual(s.calls, []);
		assert.equal(again.sessions.added + again.sessions.continued + again.sessions.conflictCopies, 0);
	});

	test("the vault's newer copy wins over an older local one", async () => {
		const s = setup();
		const a = s.ids[0] as string;
		edit(path.join(s.dataDir, "chats", `${a}.json`), (r) => ({ ...r, messages: [...r.messages, msg("newer in the vault")] }));
		const r = await s.run();
		assert.equal(r.sessions.keptVault, 1);
		assert.equal(json(s.dataDir, "chats", `${a}.json`).messages.at(-1).content, "newer in the vault");
	});

	test("prompts, switches and sources are folded in; a differing prompt keeps the vault's and saves the other", async () => {
		const s = setup();
		fs.writeFileSync(path.join(s.from, "prompts", "switches.json"), JSON.stringify({ "system-prompt.md": false, "teacher/20-teaching.md": true }));
		fs.writeFileSync(path.join(s.from, "prompts", "system-prompt.md"), "# phone prompt\n");
		fs.mkdirSync(path.join(s.from, "prompts", "teacher"), { recursive: true });
		fs.writeFileSync(path.join(s.from, "prompts", "teacher", "20-teaching.md"), "# teaching\n");
		const sources = json(s.from, "graph", "sources.json");
		fs.writeFileSync(path.join(s.from, "graph", "sources.json"), JSON.stringify({ ...sources, src_phone: { id: "src_phone", filePath: "phone.md", importedAt: "2026-10-30T00:00:00.000Z" } }));
		const r = await s.run();
		assert.deepEqual(json(s.dataDir, "prompts", "switches.json"), { "system-prompt.md": true, "teacher/20-teaching.md": true }, "a switch on anywhere stays on");
		assert.equal(read(s.dataDir, "prompts", "teacher", "20-teaching.md"), "# teaching\n");
		assert.equal(read(s.dataDir, "prompts", "system-prompt.md"), "# My override\n");
		assert.ok(files(path.join(s.localDir, "conflicts", "prompts")).some((f) => f.startsWith("system-prompt.md.")));
		assert.equal(r.prompts.keptVault, 1);
		assert.equal(r.sources.added, 1);
		assert.ok(json(s.dataDir, "graph", "sources.json").src_phone);
		assert.ok(json(s.dataDir, "graph", "sources.json").src_fixture0001, "the vault's sources stay");
	});

	test("graph lines the vault lacks go to this device's own ledger; existing nodes become links; others' files are not touched", async () => {
		const s = setup();
		const node = (id: string) => JSON.stringify({ id, name: id, statement: "s", aliases: [], createdAt: "2026-10-22T00:00:00.000Z", provenance: [] });
		// this device's pre-split shared base: one node the vault has, one it lacks, one chain, one coverage row
		fs.writeFileSync(path.join(s.from, "graph", "nodes.jsonl"), `${read(s.from, "graph", "nodes.dev_fixture1.jsonl").trim().split("\n")[0]}\n${node("n_phoneonly1")}\n`);
		fs.writeFileSync(path.join(s.from, "graph", "chains.jsonl"), `${JSON.stringify({ id: "arg_phone0001", premises: ["n_phoneonly1"], conclusion: "n_fixture0001", createdAt: "2026-10-22T00:00:00.000Z", provenance: [] })}\n`);
		const otherDevicesFiles = digest(path.join(s.dataDir, "graph"));
		const r = await s.run();
		const mine = read(s.dataDir, "graph", `nodes.${PHONE}.jsonl`).trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(mine.map((n) => n.id), ["n_phoneonly1"], "the node the vault already has is not added twice");
		assert.equal(mine[0].link, undefined, "a node nobody has defines itself");
		assert.equal(read(s.dataDir, "graph", `chains.${PHONE}.jsonl`).includes("arg_phone0001"), true);
		assert.deepEqual(r.graphLines, { added: 2, linked: 0 });
		for (const [file, hash] of Object.entries(otherDevicesFiles)) assert.equal(digest(path.join(s.dataDir, "graph"))[file], hash, `${file} untouched`);
		assert.deepEqual(s.calls.filter((c) => c.startsWith("ledger ")).sort(), [`ledger graph/chains.${PHONE}.jsonl@0`, `ledger graph/nodes.${PHONE}.jsonl@0`]);
		assert.ok(r.leftBehind.includes("graph/nodes.dev_fixture1.jsonl"), "another device's ledger comes from the vault");

		// a node that exists in the vault under a line this device wrote differently is linked
		fs.writeFileSync(path.join(s.from, "graph", "nodes.jsonl"), `${JSON.stringify({ ...JSON.parse(read(s.from, "graph", "nodes.dev_fixture1.jsonl").trim().split("\n")[0] as string), aliases: ["phone alias"] })}\n`);
		const second = await s.run();
		assert.equal(second.graphLines.linked, 1);
		const last = JSON.parse(read(s.dataDir, "graph", `nodes.${PHONE}.jsonl`).trim().split("\n").at(-1) as string);
		assert.equal(last.link, true);
		assert.deepEqual(last.aliases, ["phone alias"]);
	});

	test("the moved-aside folder is never modified, and the folders are listed for a later merge", async () => {
		const s = setup();
		edit(path.join(s.from, "chats", `${s.ids[0]}.json`), (r) => ({ ...r, messages: [...r.messages, msg("x")] }));
		const before = digest(s.from);
		assert.deepEqual(listMovedAside(s.localDir).map((m) => [m.name, m.sessions, m.merged]), [["pre-vault-20261101", 2, false]]);
		await s.run();
		assert.deepEqual(digest(s.from), before);
		assert.equal(listMovedAside(s.localDir)[0]?.merged, true);
	});

	test("a conflict copy of this device is kept beside its session", async () => {
		const s = setup();
		const a = s.ids[0] as string;
		const name = `${a}.sync-conflict-20261001-101010-ABCDEFG.json`;
		fs.writeFileSync(path.join(s.from, "chats", name), JSON.stringify({ ...json(s.from, "chats", `${a}.json`), title: "Other version" }));
		await s.run();
		assert.equal(json(s.dataDir, "chats", name).title, "Other version");
	});
});

test("a node line merged as a link is not merged again by the next run", async () => {
	const s = setup();
	const first = JSON.parse(read(s.from, "graph", "nodes.dev_fixture1.jsonl").trim().split("\n")[0] as string);
	fs.writeFileSync(path.join(s.from, "graph", "nodes.jsonl"), `${JSON.stringify({ ...first, aliases: ["phone alias"] })}\n`);
	assert.deepEqual((await s.run()).graphLines, { added: 1, linked: 1 });
	const settled = digest(s.dataDir);
	assert.deepEqual((await s.run()).graphLines, { added: 0, linked: 0 });
	assert.deepEqual(digest(s.dataDir), settled);
});
