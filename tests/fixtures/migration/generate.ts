/**
 * Writes one sample data folder with the STORE CODE OF AN OLD RELEASE, so the migration
 * fixtures are real formats and not invented ones (docs/vault-migration.md "Fixtures").
 *
 *   git worktree add --detach /tmp/lh-old/v0.4.1 v0.4.1 && ln -s "$PWD/node_modules" /tmp/lh-old/v0.4.1/node_modules
 *   npx tsx tests/fixtures/migration/generate.ts /tmp/lh-old/v0.4.1 tests/fixtures/migration/v0.4.1
 *
 * Argument 1: a checkout of the release. Argument 2: the output folder; it gets `lh-data/` and,
 * for releases that have a device-local folder (the fork from 0.3.8001), `lh-local/` (not named data/ and local/: .gitignore ignores those).
 * The only synthetic parts are the dead pre-chains ledgers some very old folders still hold
 * (edges.jsonl, events.jsonl, mappings.jsonl): nothing reads them and the migration only moves them.
 */
import fs from "node:fs";
import path from "node:path";

const [tree, out] = process.argv.slice(2).map((p) => path.resolve(p as string)) as [string, string];
if (!tree || !out) throw new Error("usage: generate.ts <release checkout> <output folder>");
fs.rmSync(out, { recursive: true, force: true });
process.env.LH_DATA_DIR = path.join(out, "lh-data");
process.env.LH_LOCAL_DIR = path.join(out, "lh-local");
const imp = (p: string) => import(path.join(tree, p)) as Promise<Record<string, any>>;

const config = await imp("config.ts");
const hasLocal = "DEVICE_FILE" in config;
const device = { id: "dev_fixture1", name: "Fixture desktop" };

const chatsMod = await imp("src/store/chats.ts");
const jobsMod = await imp("src/store/jobs.ts");
const graphMod = await imp("src/store/graph.ts");
const settingsMod = await imp("src/store/settings.ts");
const promptsMod = await imp("src/store/prompt-overrides.ts");
const posMod = graphMod;

const chats = chatsMod.chatStore;
const jobs = jobsMod.jobStore ?? jobsMod.createJobStore(() => device);
const graph = graphMod.graphStore ?? graphMod.createGraphLedgerStore(() => device.id);

const msg = (role: "user" | "assistant", text: string, n: number) =>
	role === "user" ? { id: `msg_fx${n}`, role, content: text, timestamp: 1790000000000 + n } : { id: `msg_fx${n}`, role, content: [{ type: "text", text }], timestamp: 1790000000000 + n };

const a = chats.createChat("Photosynthesis");
chats.saveMessages(a.id, [msg("user", "What is chlorophyll?", 1), msg("assistant", "A pigment that absorbs light.", 2)]);
const b = chats.createChat("Relational model");
chats.saveMessages(b.id, [msg("user", "Explain keys.", 3)]);

const done = jobs.createJob({ kind: "research", chatId: a.id, toolCallId: "call_fixture_done" });
jobs.updateJob(done.id, { status: "done", activity: "delivered", result: { brief: "fixture" } });
jobs.createJob({ kind: "research", chatId: b.id, toolCallId: "call_fixture_running" }); // left running: a crash

const stamp = "2026-10-20T10:00:00.000Z";
const n1 = { id: "n_fixture0001", name: "Chlorophyll", statement: "Chlorophyll absorbs light.", aliases: [], createdAt: stamp, provenance: [{ chatId: a.id, messageId: "msg_fx2" }] };
const n2 = { id: "n_fixture0002", name: "Photosynthesis", statement: "Plants turn light into sugar.", aliases: [], createdAt: stamp, provenance: [{ chatId: a.id, messageId: "msg_fx2" }] };
graph.appendNode(n1);
graph.appendNode(n2);
graph.appendChain({ id: "arg_fixture0001", premises: [n1.id], conclusion: n2.id, createdAt: stamp, provenance: [{ chatId: a.id, messageId: "msg_fx2" }] });
graph.appendCheckpoint({ chatId: a.id, foldedAt: stamp });
graph.appendCoverage({ chatId: a.id, fp: "f".repeat(64), tokens: 12, foldedAt: stamp });
graph.upsertSource({ id: "src_fixture0001", filePath: "notes.md", importedAt: stamp });

promptsMod.promptOverrides.writeOverride("system-prompt.md", "# My override\n");
settingsMod.writeSettings({ version: 1, agent: { prompts: { "system-prompt.md": true } }, general: {} });
posMod.graphStore ? posMod.graphStore.writePositions({ [n1.id]: { x: 1, y: 2 } }) : graph.writePositions({ [n1.id]: { x: 1, y: 2 } });
if (!hasLocal) {
	// the release keeps its device-local records in the data folder
	fs.writeFileSync(path.join(out, "lh-data", "graph", "render-settings.json"), JSON.stringify({ labelSize: 1 }, null, "\t"));
	fs.mkdirSync(path.join(out, "lh-data", "debug", "provider-events"), { recursive: true });
	fs.writeFileSync(path.join(out, "lh-data", "debug", "provider-events", `${a.id}.jsonl`), '{"t":1}\n');
}
if (hasLocal && !fs.existsSync(config.DEVICE_FILE)) fs.writeFileSync(config.DEVICE_FILE, JSON.stringify(device, null, "\t"));
if (process.argv[4] === "dead-ledgers") {
	for (const f of ["edges", "events", "mappings"]) fs.writeFileSync(path.join(out, "lh-data", "graph", `${f}.jsonl`), '{"legacy":true}\n');
}
console.log(`wrote ${out}`);
