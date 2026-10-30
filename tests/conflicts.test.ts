/**
 * CONFLICT COPIES OF SESSIONS (multi-device, GLOSSARY "Conflict copy"):
 * when two devices changed one session before syncing, Syncthing keeps the
 * other version beside it as chat_<id>.sync-conflict-<date>-<time>-<device>.json.
 * The session list ignores such files, the session lists them, and the
 * learner picks the version to keep; the other one moves to the
 * device-local conflicts folder, never deleted.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-conflicts-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");

const { stores } = await import("../src/server/stores.ts");
const recordRoute = await import("../app/api/chats/[id]/route.ts");
const resolveRoute = await import("../app/api/chats/[id]/conflicts/route.ts");
const { PATHS, CONFLICTS_DIR } = await import("../config.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const chatPath = (name: string) => path.join(PATHS.chats, name);

/** A session plus a conflict copy whose transcript went another way. */
function conflicted(title: string) {
	const chat = stores.chatStore.createChat(title);
	stores.chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "mine", timestamp: 1 } as never]);
	const other = { ...stores.chatStore.getChat(chat.id)!, messages: [
		{ id: "u1", role: "user", content: "mine", timestamp: 1 },
		{ id: "u2", role: "user", content: "theirs", timestamp: 2 },
	], updatedAt: "2026-10-30T11:00:00.000Z" };
	const name = `${chat.id}.sync-conflict-20261030-110000-ABCDEF7.json`;
	fs.writeFileSync(chatPath(name), JSON.stringify(other));
	return { id: chat.id, name };
}

test("the session list ignores conflict copies and still lists every session", () => {
	const { id } = conflicted("listed once");
	const ids = stores.chatStore.listChats().map((c) => c.id);
	assert.deepEqual(ids.filter((x) => x === id), [id]);
	assert.ok(ids.every((x) => !x.includes("sync-conflict")));
});

test("the session record lists its conflict copies", async () => {
	const { id, name } = conflicted("listed copy");
	const record = await (await recordRoute.GET(new Request("http://t"), ctx(id))).json();
	assert.deepEqual(record.conflicts, [{ file: name, updatedAt: "2026-10-30T11:00:00.000Z", messageCount: 2 }]);
});

test("keeping the other version replaces this one; this one moves to the conflicts folder", async () => {
	const { id, name } = conflicted("keep theirs");
	const mine = fs.readFileSync(chatPath(`${id}.json`), "utf-8");
	const res = await resolveRoute.POST(new Request("http://t", { method: "POST", body: JSON.stringify({ keep: name }) }), ctx(id));
	assert.equal(res.status, 200);
	assert.equal(stores.chatStore.getChat(id)!.messages.length, 2);
	assert.equal(fs.existsSync(chatPath(name)), false);
	const moved = fs.readdirSync(CONFLICTS_DIR).filter((f) => f.startsWith(id));
	assert.equal(moved.length, 1);
	assert.equal(fs.readFileSync(path.join(CONFLICTS_DIR, moved[0]!), "utf-8"), mine);
});

test("keeping this version moves the conflict copy to the conflicts folder", async () => {
	const { id, name } = conflicted("keep mine");
	const res = await resolveRoute.POST(new Request("http://t", { method: "POST", body: JSON.stringify({ keep: "current" }) }), ctx(id));
	assert.equal(res.status, 200);
	assert.equal(stores.chatStore.getChat(id)!.messages.length, 1);
	assert.ok(fs.existsSync(path.join(CONFLICTS_DIR, name)));
	const record = await (await recordRoute.GET(new Request("http://t"), ctx(id))).json();
	assert.deepEqual(record.conflicts, []);
});

test("a keep that names no conflict copy of this session is refused", async () => {
	const { id } = conflicted("bad keep");
	for (const keep of ["../../etc/passwd", "chat_other.sync-conflict-20261030-110000-ABCDEF7.json", 42]) {
		const res = await resolveRoute.POST(new Request("http://t", { method: "POST", body: JSON.stringify({ keep }) }), ctx(id));
		assert.equal(res.status, 400, String(keep));
	}
});

test("deleting a session moves its conflict copies aside instead of leaving them behind (owner, 2026-10-30)", () => {
	const { id, name } = conflicted("deleted with a copy");
	assert.equal(stores.chatStore.deleteChat(id), true);
	assert.equal(fs.existsSync(chatPath(name)), false);
	assert.ok(fs.existsSync(path.join(CONFLICTS_DIR, name)));
});
