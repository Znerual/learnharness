/**
 * A HANDED-OFF SESSION WHOSE MODEL IS NOT SET UP HERE (multi-device, ADR
 * 0002): model configuration is device-local, so a session stamped on the
 * desktop with, say, a custom endpoint the phone lacks must ask the learner
 * to pick a model — never switch silently, never fail with a bare 503.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-model-unavailable-"));
process.env.LH_DATA_DIR = path.join(DIR, "data");
process.env.LH_LOCAL_DIR = path.join(DIR, "local");
process.env.LH_AUTH_FILE = path.join(DIR, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { stores } = await import("../src/server/stores.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const recordRoute = await import("../app/api/chats/[id]/route.ts");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test("a session stamped with a provider this device lacks answers 503 model_unavailable and says which model", async () => {
	const chat = stores.chatStore.createChat("from the desktop");
	stores.chatStore.saveSettings(chat.id, { model: { provider: "ait", id: "qwen3-32b" } });
	const res = await handleChatInput(chat.id, { type: "text", text: "hello" });
	assert.equal(res.status, 503);
	const body = (await res.json()) as { code: string; provider: string; id: string; error: string };
	assert.deepEqual([body.code, body.provider, body.id], ["model_unavailable", "ait", "qwen3-32b"]);
	assert.match(body.error, /ait/);
	const record = await (await recordRoute.GET(new Request("http://t"), ctx(chat.id))).json();
	assert.equal(record.modelAvailable, false);
});

test("a session stamped with a model missing from a known provider's catalog is unavailable too", async () => {
	const chat = stores.chatStore.createChat("unknown model");
	stores.chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "no-such/model-xyz" } });
	const res = await handleChatInput(chat.id, { type: "text", text: "hello" });
	assert.equal(res.status, 503);
	assert.equal(((await res.json()) as { code: string }).code, "model_unavailable");
});

test("a session whose model this device has is available", async () => {
	const chat = stores.chatStore.createChat("fine here");
	const record = await (await recordRoute.GET(new Request("http://t"), ctx(chat.id))).json();
	assert.equal(record.modelAvailable, true, "no stamped model: the strong slot decides, nothing to hand off");
});
