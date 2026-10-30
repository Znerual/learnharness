/**
 * GET /api/busy (multi-device, step 4): the Android shell keeps a
 * foreground service alive only while this device's server is working —
 * a turn, a background job, or an extraction run — so Android does not
 * kill work in progress, and stops it when nothing runs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-busy-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");

const busyRoute = await import("../app/api/busy/route.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { registerJobAbort, unregisterJobAbort } = await import("../src/agent/subagents/aborts.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const busy = async () => ((await (await busyRoute.GET()).json()) as { busy: boolean }).busy;

test("idle: not busy", async () => {
	assert.equal(await busy(), false);
});

test("busy while a turn runs, idle again when it settles", async () => {
	beginTurn("chat_busy_turn");
	assert.equal(await busy(), true);
	endTurn("chat_busy_turn");
	assert.equal(await busy(), false);
});

test("busy while a background job's loop runs", async () => {
	registerJobAbort("job_busy", new AbortController());
	assert.equal(await busy(), true);
	unregisterJobAbort("job_busy");
	assert.equal(await busy(), false);
});
