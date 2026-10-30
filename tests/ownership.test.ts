/**
 * THE OWNING DEVICE (multi-device, GLOSSARY "Owning device", "Takeover"):
 * while a turn or a background job runs on one device, the session record
 * and the job records name that device. Another device keeps the session
 * read-only — no turn, no job re-run — until the work settles and syncs,
 * or the learner takes over. This device's own leftover marker (a crash)
 * never blocks it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ownership-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");
process.env.LH_AUTH_FILE = path.join(DIR, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");

const { stores } = await import("../src/server/stores.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { recoverStaleJobs, setJobRespawn } = await import("../src/server/jobs.ts");
const takeoverRoute = await import("../app/api/chats/[id]/takeover/route.ts");
const recordRoute = await import("../app/api/chats/[id]/route.ts");
const { PATHS } = await import("../config.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const self = stores.deviceStore.getDevice();
const desktop = { deviceId: "dev_desktop1", deviceName: "Desktop" };

/** What a synced-in record from the other device looks like on disk. */
function editRecord(chatId: string, patch: Record<string, unknown>): void {
	const file = path.join(PATHS.chats, `${chatId}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), ...patch }));
}
function editJob(jobId: string, patch: Record<string, unknown>): void {
	const file = path.join(PATHS.data, "jobs", `${jobId}.json`);
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), ...patch }));
}
const send = (chatId: string) => handleChatInput(chatId, { type: "text", text: "hello" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test("a turn running on another device makes the session refuse turns here, naming that device", async () => {
	const chat = stores.chatStore.createChat("owned by the desktop");
	editRecord(chat.id, { activeTurn: { ...desktop, startedAt: "2026-10-30T10:00:00.000Z" } });
	const res = await send(chat.id);
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), {
		error: "This session is running on Desktop",
		code: "owned_elsewhere",
		owner: { deviceId: "dev_desktop1", deviceName: "Desktop", since: "2026-10-30T10:00:00.000Z", kind: "turn" },
	});
	const record = await (await recordRoute.GET(new Request("http://t"), ctx(chat.id))).json();
	assert.equal(record.ownedElsewhere.deviceName, "Desktop");
});

test("this device's own leftover marker (a crashed turn) does not block it", async () => {
	const chat = stores.chatStore.createChat("own stale marker");
	editRecord(chat.id, { activeTurn: { deviceId: self.id, deviceName: self.name, startedAt: "2026-10-30T09:00:00.000Z" } });
	const res = await send(chat.id);
	assert.notEqual(res.status, 409, "past the ownership gate (no models are configured, so the turn gate answers)");
});

test("a background job running on another device also makes the session read-only here", async () => {
	const chat = stores.chatStore.createChat("job on the desktop");
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-1" });
	assert.equal(job.deviceId, self.id, "jobs record the device that runs them");
	editJob(job.id, { deviceId: desktop.deviceId, deviceName: desktop.deviceName });
	const res = await send(chat.id);
	assert.equal(res.status, 409);
	const body = (await res.json()) as { owner: { kind: string; deviceName: string } };
	assert.deepEqual([body.owner.kind, body.owner.deviceName], ["job", "Desktop"]);
});

test("the stale-job sweep never re-runs another device's job, but still recovers this device's orphans", () => {
	const chat = stores.chatStore.createChat("sweep");
	const foreign = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-f" });
	editJob(foreign.id, { deviceId: desktop.deviceId, deviceName: desktop.deviceName });
	const own = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-o" });
	const respawned: string[] = [];
	setJobRespawn((id) => void respawned.push(id));
	(globalThis as { __lhWakePipeline?: { lastSweepAt: number } }).__lhWakePipeline!.lastSweepAt = 0;
	recoverStaleJobs();
	assert.ok(!respawned.includes(foreign.id));
	assert.ok(respawned.includes(own.id));
});

test("takeover clears the other device's marker and stops its running jobs here", async () => {
	const chat = stores.chatStore.createChat("take it over");
	editRecord(chat.id, { activeTurn: { ...desktop, startedAt: "2026-10-30T10:00:00.000Z" } });
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-t" });
	editJob(job.id, { deviceId: desktop.deviceId, deviceName: desktop.deviceName });

	const res = await takeoverRoute.POST(new Request("http://t", { method: "POST" }), ctx(chat.id));
	assert.equal(res.status, 200);
	assert.equal(stores.chatStore.getChat(chat.id)!.activeTurn, undefined);
	const after = stores.jobStore.getJob(job.id)!;
	assert.equal(after.status, "error");
	assert.equal(after.error, `Taken over on ${self.name}`);
	assert.equal(after.deviceId, self.id, "the abort notice is now this device's to deliver");
	assert.equal(after.delivery?.kind, "abort");
	const record = await (await recordRoute.GET(new Request("http://t"), ctx(chat.id))).json();
	assert.equal(record.ownedElsewhere, null);
});

test("takeover of a session nobody else owns is a no-op 200", async () => {
	const chat = stores.chatStore.createChat("free");
	const res = await takeoverRoute.POST(new Request("http://t", { method: "POST" }), ctx(chat.id));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, jobsStopped: 0 });
});
