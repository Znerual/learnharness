/**
 * The Obsidian integration (obsidian wave, owner 2026-10-24). Pinned:
 *  - the pure renderer: one note per birth session, Sessions/ vs Notes/,
 *    clash suffixes, sanitized names/headings, duplicate headings, chains
 *    under their conclusion with in-note and cross-note heading links,
 *    the backlink to the original vault note, deterministic output;
 *  - the writer: creates notes, rewrites nothing when unchanged, deletes
 *    only stale files carrying the lh_export marker;
 *  - the Sync: exclusions, skip-unchanged by fingerprint, retry after a
 *    failed import, one Sync at a time, a models refusal stops the run;
 *  - the vault-path setting: parse + sanitize.
 *
 * LH_DATA_DIR redirects to a fresh tmp dir BEFORE the store modules load.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-obsidian-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { renderObsidianExport, sanitizeHeading, sanitizeNoteName } = await import("../src/core/obsidian-export.ts");
const { stores } = await import("../src/server/stores.ts");
const obsidian = await import("../src/server/obsidian.ts");
const { notesSourceId } = await import("../src/agent/subagents/extraction.ts");
const { parseGraphSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");
const { vaultSyncHint, vaultSyncLabel } = await import("../components/vault-sync.tsx");
type GraphNode = import("../src/core/contracts.ts").GraphNode;
type GraphChain = import("../src/core/contracts.ts").GraphChain;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const node = (id: string, name: string, birth: string, createdAt: string, extra: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} is a statement.`,
	aliases: [],
	createdAt,
	provenance: [{ chatId: birth, messageId: "m1" }],
	...extra,
});
const chain = (id: string, premises: string[], conclusion: string, createdAt: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [{ chatId: "chat_a", messageId: "m1" }],
	createdAt,
});

describe("the export renderer", () => {
	const input = {
		propositions: [
			node("n1", "Determinant", "chat_a", "2026-10-01T00:00:00Z", { aliases: ["det", "Determinant"] }),
			node("n2", "Volume scaling: area", "chat_a", "2026-10-01T00:00:01Z"),
			node("n3", "Determinant", "chat_a", "2026-10-01T00:00:02Z"),
			node("n4", "Singular matrix", "chat_b", "2026-10-02T00:00:00Z"),
			node("n5", "Animal Farm", "src_x", "2026-10-03T00:00:00Z"),
			node("n6", "Orphan", "chat_gone", "2026-10-03T00:00:00Z", { provenance: [] }),
		],
		chains: [chain("arg_1", ["n1", "n2"], "n4", "2026-10-02T00:00:01Z"), chain("arg_2", ["n1"], "n3", "2026-10-01T00:00:03Z")],
		sessions: { chat_a: "Linear algebra", chat_b: "Linear algebra", chat_gone: "x" },
		fileSources: { src_x: "Inbox/2026-06-24 Animal Farm.md" },
	};
	const files = renderObsidianExport(input);
	const byPath = new Map(files.map((f) => [f.relPath, f.content]));

	it("writes one note per birth session, Sessions/ vs Notes/, clash-suffixed", () => {
		assert.deepEqual([...byPath.keys()], [
			"LearnHarness/Sessions/Linear algebra.md",
			"LearnHarness/Sessions/Linear algebra (b).md",
			"LearnHarness/Notes/2026-06-24 Animal Farm.md",
		]);
	});
	it("marks the note, numbers duplicate headings, sanitizes heading text, lists aliases", () => {
		const a = byPath.get("LearnHarness/Sessions/Linear algebra.md")!;
		assert.ok(a.startsWith("---\nlh_export: true\nlh_source: chat_a\nlh_kind: session\nupdated: 2026-10-01T00:00:03Z\n---\n# Linear algebra\n"));
		assert.match(a, /^## Determinant$/m);
		assert.match(a, /^## Determinant \(2\)$/m);
		assert.match(a, /^## Volume scaling - area$/m);
		assert.match(a, /^\*Also:\* det$/m);
		assert.match(a, /^Because \[\[#Determinant\|Determinant\]\] ⟹ Determinant$/m);
	});
	it("links premises across notes by heading", () => {
		const b = byPath.get("LearnHarness/Sessions/Linear algebra (b).md")!;
		assert.match(
			b,
			/^Because \[\[LearnHarness\/Sessions\/Linear algebra#Determinant\|Determinant\]\] ∧ \[\[LearnHarness\/Sessions\/Linear algebra#Volume scaling - area\|Volume scaling: area\]\] ⟹ Singular matrix$/m,
		);
	});
	it("links an imported note back to the original", () => {
		assert.match(byPath.get("LearnHarness/Notes/2026-06-24 Animal Farm.md")!, /^Source: \[\[Inbox\/2026-06-24 Animal Farm\]\]$/m);
	});
	it("is deterministic and skips provenance-less nodes", () => {
		assert.deepEqual(renderObsidianExport(input), files);
		assert.ok(!files.some((f) => f.content.includes("Orphan")));
	});
	it("sanitizes names and headings", () => {
		assert.equal(sanitizeNoteName('a/b:c*?"<>|#^[]  d'), "a b c d");
		assert.equal(sanitizeNoteName("..."), "Untitled");
		assert.equal(sanitizeHeading("x#y|z^[w]%"), "x y z w");
	});
});

describe("the export writer", () => {
	const vault = path.join(TMP, "vault-export");
	fs.mkdirSync(vault, { recursive: true });
	const chat = stores.chatStore.createChat("Eigenvalues");
	stores.graphStore.appendNode(node("n_w1", "Eigenvector", chat.id, "2026-10-05T00:00:00Z"));

	it("creates the notes, then rewrites nothing when unchanged", () => {
		assert.deepEqual(obsidian.writeObsidianExport(vault), { written: 1, unchanged: 0, deleted: 0 });
		assert.ok(fs.readFileSync(path.join(vault, "LearnHarness/Sessions/Eigenvalues.md"), "utf-8").includes("## Eigenvector"));
		assert.deepEqual(obsidian.writeObsidianExport(vault), { written: 0, unchanged: 1, deleted: 0 });
	});
	it("deletes only stale files that carry the marker", () => {
		const dir = path.join(vault, "LearnHarness/Sessions");
		fs.writeFileSync(path.join(dir, "Stale.md"), "---\nlh_export: true\n---\n# Stale\n");
		fs.writeFileSync(path.join(dir, "Mine.md"), "# My own note\n");
		assert.deepEqual(obsidian.writeObsidianExport(vault), { written: 0, unchanged: 1, deleted: 1 });
		assert.ok(!fs.existsSync(path.join(dir, "Stale.md")));
		assert.ok(fs.existsSync(path.join(dir, "Mine.md")));
	});
});

describe("the vault Sync", () => {
	const vault = path.join(TMP, "vault-sync");
	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
		fs.writeFileSync(path.join(vault, rel), text);
	};
	write("Files/a.md", "note a");
	write("Inbox/b.md", "note b");
	write("Files/empty.md", "   \n");
	write("Files/a.sync-conflict-20260101-000000-X.md", "conflict");
	write("LearnHarness/Sessions/s.md", "---\nlh_export: true\n---\n");
	write(".obsidian/x.md", "config");
	write(".trash/old.md", "gone");
	write(".stfolder/y.md", "sync");
	write("Files/pic.png", "binary");

	/** A fake front door that records calls and upserts the source like
	 *  importNotes does (clearing any vaultFp). */
	const calls: string[] = [];
	let failOn: string | null = null;
	const fakeImport = async ({ filePath }: { filePath: string; text: string }) => {
		calls.push(filePath);
		stores.graphStore.upsertSource({ id: notesSourceId(filePath), filePath, importedAt: "2026-10-24T00:00:00Z" });
		if (filePath === failOn) throw new Error("synthetic failure");
		return { nodes: 1, chains: 0 };
	};

	it("scans only importable notes", () => {
		assert.deepEqual(obsidian.scanVault(vault).map((n) => n.relPath), ["Files/a.md", "Inbox/b.md"]);
	});
	it("imports new notes, stamps them, and skips them next time", async () => {
		failOn = "Inbox/b.md";
		const run = obsidian.startVaultSync(vault, fakeImport)!;
		assert.equal(obsidian.startVaultSync(vault, fakeImport), null, "one Sync at a time");
		await run.finished;
		assert.deepEqual(calls.sort(), ["Files/a.md", "Inbox/b.md"]);
		assert.deepEqual(obsidian.vaultSyncStatus(), { running: false, total: 2, skipped: 0, done: 1, failed: 1 });
		// The failed file has no fingerprint — retried; the done one skipped.
		calls.length = 0;
		failOn = null;
		await obsidian.startVaultSync(vault, fakeImport)!.finished;
		assert.deepEqual(calls, ["Inbox/b.md"]);
		assert.deepEqual(obsidian.vaultSyncStatus(), { running: false, total: 1, skipped: 1, done: 1, failed: 0 });
		// A changed note is imported again.
		calls.length = 0;
		write("Files/a.md", "note a, edited");
		await obsidian.startVaultSync(vault, fakeImport)!.finished;
		assert.deepEqual(calls, ["Files/a.md"]);
	});
	it("a models refusal stops the whole run", async () => {
		write("Files/c.md", "note c");
		write("Files/d.md", "note d");
		const refuse = async () => {
			throw new ModelsNotConfiguredError(["cheap"]);
		};
		await obsidian.startVaultSync(vault, refuse)!.finished;
		const status = obsidian.vaultSyncStatus();
		assert.equal(status.running, false);
		assert.equal(status.done, 0);
		assert.match(status.error ?? "", /No model configured/);
	});
	it("the button reads the counters", () => {
		assert.equal(vaultSyncLabel({ running: true, total: 5, skipped: 2, done: 1, failed: 1 }), "Syncing 2/5…");
		assert.equal(vaultSyncLabel(null), "Sync vault");
		assert.equal(vaultSyncHint({ running: false, total: 2, skipped: 3, done: 1, failed: 1 }, null), "Last sync: 1 imported, 1 failed, 3 unchanged");
		assert.equal(vaultSyncHint(null, "boom"), "boom");
	});
});

describe("the vault-path setting", () => {
	it("parses absolute paths and null, rejects relative ones", () => {
		assert.deepEqual(parseGraphSettingsBody({ obsidianVault: " /home/u/Notes " }), { ok: true, settings: { obsidianVault: "/home/u/Notes" } });
		assert.deepEqual(parseGraphSettingsBody({ obsidianVault: null }), { ok: true, settings: { obsidianVault: null } });
		assert.deepEqual(parseGraphSettingsBody({ obsidianVault: "" }), { ok: true, settings: { obsidianVault: null } });
		assert.ok(!parseGraphSettingsBody({ obsidianVault: "Notes" }).ok);
		assert.ok(!parseGraphSettingsBody({ obsidianVault: 3 }).ok);
	});
	it("the sanitizer keeps a string, drops junk", () => {
		assert.equal(sanitizeUserSettings({ version: 1, graph: { obsidianVault: "/v" } })?.graph?.obsidianVault, "/v");
		assert.equal(sanitizeUserSettings({ version: 1, graph: { obsidianVault: 7 } })?.graph?.obsidianVault, undefined);
	});
	it("isExistingDirectory checks the filesystem", () => {
		assert.ok(obsidian.isExistingDirectory(TMP));
		assert.ok(!obsidian.isExistingDirectory(path.join(TMP, "nope")));
	});
});
