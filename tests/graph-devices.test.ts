/**
 * ONE GRAPH LEDGER PER DEVICE (multi-device, ADR 0003): every device
 * appends only to its own ledger files in the shared data folder and reads
 * the union of all devices' files plus the legacy shared base. Deletions
 * are records in the deleting device's own file, applied on read; chain
 * simplification happens on read. Two fs GraphStores with different device
 * ids share ONE temp data folder here — what a file-sync tool produces on disk.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { GraphChain, GraphNode, SessionFindings } from "../src/core/contracts.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-devices-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");

const { createGraphLedgerStore } = await import("../src/store/graph.ts");
const { effectiveGraphStore } = await import("../src/core/graph-ledgers.ts");
const createGraphStore = (deviceId: () => string) => effectiveGraphStore(createGraphLedgerStore(deviceId));
const { chatStore } = await import("../src/store/chats.ts");
const { getGraph, mergeFindings } = await import("../src/core/graph.ts");
const { deleteChatTraces, deleteNodeTraces } = await import("../src/core/graph-deletion.ts");
const { PATHS, GRAPH_FORMAT_FILE } = await import("../config.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const A = "dev_aaaaaaaa";
const B = "dev_bbbbbbbb";
const graphDir = () => PATHS.graph;
const file = (name: string) => path.join(graphDir(), name);
const lines = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf-8").trim().split("\n").filter(Boolean) : []);

function freshFolder() {
	fs.rmSync(path.join(DIR, "data"), { recursive: true, force: true });
	fs.rmSync(path.join(DIR, "local"), { recursive: true, force: true });
	const a = createGraphStore(() => A);
	const b = createGraphStore(() => B);
	return { a, b, depsA: { chatStore, graphStore: a }, depsB: { chatStore, graphStore: b } };
}

const finding = (id: string, statement: string): SessionFindings["propositions"][number] => ({ id, name: statement.split(" ")[0]!, statement, aliases: [] });

function chatFor(title: string): string {
	return chatStore.createChat(title).id;
}

describe("one ledger per device", () => {
	it("each device appends only to its own files, and both devices see the same graph", () => {
		const { a, b, depsA, depsB } = freshFolder();
		const chatA = chatFor("A's session");
		const chatB = chatFor("B's session");
		mergeFindings(chatA, { propositions: [finding("p1", "Entropy measures disorder")], chains: [] }, { links: [] }, depsA, { foldedAt: "x" });
		const entropy = getGraph(a).nodes[0]!.id;
		mergeFindings(
			chatB,
			{ propositions: [finding("q1", "Entropy is disorder, rephrased"), finding("q2", "Heat flows downhill")], chains: [{ premises: ["q1"], conclusion: "q2" }] },
			{ links: [{ id: "q1", linkTo: entropy }] },
			depsB,
			{ foldedAt: "x" },
		);

		assert.equal(lines(`nodes.${A}.jsonl`).length, 1);
		assert.equal(lines(`nodes.${B}.jsonl`).length, 2);
		assert.equal(lines(`chains.${B}.jsonl`).length, 1);
		assert.equal(fs.existsSync(file("nodes.jsonl")), false, "the legacy shared base is never written");
		assert.deepEqual(getGraph(a), getGraph(b));
		const node = getGraph(a).nodes.find((n) => n.id === entropy)!;
		assert.equal(node.statement, "Entropy measures disorder");
		assert.ok(node.aliases.includes("Entropy is disorder, rephrased"));
		assert.deepEqual(node.provenance.map((p) => p.chatId).sort(), [chatA, chatB].sort());
	});

	it("a node's identity comes from its create line, whichever device's file is read first", () => {
		const { a, b, depsA, depsB } = freshFolder();
		const chat = chatFor("order");
		// B (read second, by file name) creates; A (read first) links.
		mergeFindings(chat, { propositions: [finding("p1", "Created on B")], chains: [] }, { links: [] }, depsB, { foldedAt: "x" });
		const id = getGraph(b).nodes[0]!.id;
		mergeFindings(chat, { propositions: [finding("p2", "Linked on A")], chains: [] }, { links: [{ id: "p2", linkTo: id }] }, depsA, { foldedAt: "x" });
		assert.ok(JSON.parse(lines(`nodes.${A}.jsonl`)[0]!).link, "a link line carries the marker");
		for (const store of [a, b]) {
			const node = getGraph(store).nodes.find((n) => n.id === id)!;
			assert.equal(node.statement, "Created on B");
			assert.deepEqual(node.aliases, ["Linked on A"]);
		}
	});

	it("the legacy shared base is read by every device and never rewritten", () => {
		const { a, b, depsA } = freshFolder();
		fs.mkdirSync(graphDir(), { recursive: true });
		const legacy: GraphNode[] = [
			{ id: "n_legacy", name: "Legacy", statement: "Legacy statement", aliases: [], createdAt: "2026-09-01T00:00:00.000Z", provenance: [{ chatId: "chat_old", messageId: "" }] },
			{ id: "n_legacy", name: "Again", statement: "Legacy rephrased", aliases: [], createdAt: "2026-09-02T00:00:00.000Z", provenance: [{ chatId: "chat_old2", messageId: "" }] },
		];
		fs.writeFileSync(file("nodes.jsonl"), legacy.map((l) => JSON.stringify(l)).join("\n") + "\n");
		const before = fs.readFileSync(file("nodes.jsonl"));
		const chat = chatFor("legacy link");
		mergeFindings(chat, { propositions: [finding("p1", "Legacy from A")], chains: [] }, { links: [{ id: "p1", linkTo: "n_legacy" }] }, depsA, { foldedAt: "x" });
		assert.deepEqual(fs.readFileSync(file("nodes.jsonl")), before);
		for (const store of [a, b]) {
			const node = getGraph(store).nodes.find((n) => n.id === "n_legacy")!;
			assert.equal(node.statement, "Legacy statement", "legacy file order still defines the node");
			assert.deepEqual(node.aliases.sort(), ["Legacy from A", "Legacy rephrased"]);
		}
	});
});

describe("deletion records", () => {
	it("a session deletion is a record in the deleting device's file; no ledger is rewritten and every device applies it", () => {
		const { a, b, depsA } = freshFolder();
		const chat = chatFor("doomed");
		mergeFindings(chat, { propositions: [finding("p1", "Only in the doomed session")], chains: [] }, { links: [] }, depsA, { foldedAt: "x" });
		a.appendCoverage({ chatId: chat, fp: "fp1", tokens: 5, foldedAt: new Date().toISOString() });
		const nodesBefore = fs.readFileSync(file(`nodes.${A}.jsonl`));

		const stats = deleteChatTraces(b, chat, "delete-nodes");
		assert.equal(stats.nodesRemoved, 1);
		assert.deepEqual(fs.readFileSync(file(`nodes.${A}.jsonl`)), nodesBefore, "A's file is untouched");
		const [record] = lines(`deletions.${B}.jsonl`).map((l) => JSON.parse(l));
		assert.deepEqual({ ...record, at: "" }, { type: "session", chatId: chat, mode: "delete-nodes", at: "" });
		for (const store of [a, b]) {
			assert.equal(getGraph(store).nodes.length, 0);
			assert.equal(store.readCoverage().length, 1, "the coverage stays: a returning session does not re-extract (owner, 2026-10-30)");
		}
	});

	it("a deleted session that comes back (continued on another device) contributes again after the deletion", () => {
		const { a, b, depsA } = freshFolder();
		const chat = chatFor("resurrected");
		mergeFindings(chat, { propositions: [finding("p1", "Before the deletion")], chains: [] }, { links: [] }, depsA, { foldedAt: "x" });
		deleteChatTraces(b, chat, "delete-nodes");
		mergeFindings(chat, { propositions: [finding("p2", "After the deletion")], chains: [] }, { links: [] }, depsA, { foldedAt: "x" });
		for (const store of [a, b]) {
			assert.deepEqual(getGraph(store).nodes.map((n) => n.statement), ["After the deletion"]);
		}
	});

	it("a node deletion is permanent: a later link from another device does not bring the node back", () => {
		const { a, b, depsA, depsB } = freshFolder();
		const chat = chatFor("node death");
		mergeFindings(chat, { propositions: [finding("p1", "Doomed node"), finding("p2", "Survivor")], chains: [{ premises: ["p1"], conclusion: "p2" }] }, { links: [] }, depsA, { foldedAt: "x" });
		const doomed = getGraph(a).nodes.find((n) => n.statement === "Doomed node")!.id;
		assert.deepEqual(deleteNodeTraces(b, doomed), { chainsRemoved: 1 });
		// Device A had not synced the deletion yet when it linked to the node.
		a.appendNode({ id: doomed, name: "Doomed", statement: "Doomed node again", aliases: [], createdAt: new Date().toISOString(), provenance: [{ chatId: chat, messageId: "" }], link: true });
		for (const store of [a, b]) {
			const graph = getGraph(store);
			assert.deepEqual(graph.nodes.map((n) => n.statement), ["Survivor"]);
			assert.equal(graph.chains.length, 0);
		}
		void depsB;
	});
});

describe("argument deletion across devices", () => {
	it("deleting an argument removes its twin that another device asserted under a different id (owner, 2026-10-30)", () => {
		const { a, b } = freshFolder();
		const node = (id: string): GraphNode => ({ id, name: id, statement: `statement ${id}`, aliases: [], createdAt: "2026-09-30T00:00:00.000Z", provenance: [{ chatId: "chat_t", messageId: "" }] });
		for (const id of ["n_p", "n_q"]) a.appendNode(node(id));
		a.appendChain({ id: "arg_on_a", premises: ["n_p"], conclusion: "n_q", createdAt: "2026-09-30T01:00:00.000Z", provenance: [{ chatId: "chat_t", messageId: "" }] });
		b.appendChain({ id: "arg_on_b", premises: ["n_p"], conclusion: "n_q", createdAt: "2026-09-30T02:00:00.000Z", provenance: [{ chatId: "chat_u", messageId: "" }] });
		assert.equal(getGraph(a).chains.length, 1, "the view merges the twins into one argument");

		assert.deepEqual(deleteNodeTraces(a, getGraph(a).chains[0]!.id), { chainsRemoved: 2 });
		const [record] = lines(`deletions.${A}.jsonl`).map((l) => JSON.parse(l));
		assert.deepEqual({ ...record, at: "" }, { type: "chain", id: "arg_on_a", premises: ["n_p"], conclusion: "n_q", at: "" });
		for (const store of [a, b]) assert.equal(getGraph(store).chains.length, 0);
	});
});

describe("chain simplification on read", () => {
	it("a redundant chain stays on disk, but no device sees it", () => {
		const { a, b } = freshFolder();
		const node = (id: string): GraphNode => ({ id, name: id, statement: `statement ${id}`, aliases: [], createdAt: "2026-09-30T00:00:00.000Z", provenance: [{ chatId: "chat_s", messageId: "" }] });
		const chain = (id: string, premises: string[], conclusion: string, createdAt: string): GraphChain => ({ id, premises, conclusion, createdAt, provenance: [{ chatId: "chat_s", messageId: "" }] });
		for (const id of ["n_a", "n_b", "n_c", "n_x", "n_y"]) a.appendNode(node(id));
		a.appendChain(chain("arg_1", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00.000Z"));
		a.appendChain(chain("arg_2", ["n_x", "n_c"], "n_y", "2026-09-30T02:00:00.000Z"));
		b.appendChain(chain("arg_3", ["n_a", "n_b", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"));
		assert.equal(lines(`chains.${B}.jsonl`).length, 1, "the redundant assertion is stored");
		for (const store of [a, b]) assert.deepEqual(store.readChains().map((c) => c.id).sort(), ["arg_1", "arg_2"]);
	});
});

describe("graph format", () => {
	it("the first write stamps format 2, and an existing v1 stamp is raised to 2", () => {
		const { a } = freshFolder();
		fs.mkdirSync(graphDir(), { recursive: true });
		fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 1 }));
		a.appendCoverage({ chatId: "chat_f", fp: "fp", tokens: 1, foldedAt: new Date().toISOString() });
		assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf-8")).version, 2);
	});
});
