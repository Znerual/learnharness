/**
 * RECORDS FROM A NEWER APP (multi-device, ADR 0002): devices update at
 * different times, so a synced session or graph may carry a schema version
 * this build does not understand. It must show up as "made by a newer
 * LearnHarness — update this app", never vanish or crash.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-newer-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");

const { stores } = await import("../src/server/stores.ts");
const graphRoute = await import("../app/api/graph/route.ts");
const { PATHS, GRAPH_FORMAT_FILE } = await import("../config.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("a session saved by a newer app lists as a placeholder with its title", () => {
	const current = stores.chatStore.createChat("today's session");
	fs.writeFileSync(
		path.join(PATHS.chats, "chat_future_1.json"),
		JSON.stringify({ id: "chat_future_1", title: "From the future", createdAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T12:00:00.000Z", messages: [], version: 99 }),
	);
	const list = stores.chatStore.listChats();
	const future = list.find((c) => c.id === "chat_future_1");
	assert.ok(future, "the newer session is listed, not dropped");
	assert.equal(future.newer, true);
	assert.equal(future.title, "From the future");
	assert.equal(future.updatedAt, "2026-10-30T12:00:00.000Z");
	assert.equal(list.find((c) => c.id === current.id)?.newer, undefined);
	assert.equal(stores.chatStore.getChat("chat_future_1"), null, "it still never reads as a record");
});

test("a graph saved by a newer app answers 409 graph_format_newer instead of crashing", async () => {
	fs.mkdirSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true });
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 99 }));
	const res = await graphRoute.GET();
	assert.equal(res.status, 409);
	const body = (await res.json()) as { code: string; error: string };
	assert.equal(body.code, "graph_format_newer");
	assert.match(body.error, /newer/i);
});
