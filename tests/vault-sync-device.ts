/**
 * One simulated LearnHarness installation for tests/vault-sync-e2e.test.ts: a child process with its
 * own LH_DATA_DIR / LH_LOCAL_DIR that loads the app's real composition root (src/server/stores.ts)
 * and the real vault service (src/server/vault/service.ts), then answers JSON commands on stdin.
 * Not a test file itself (the name does not match tests/*.test.ts).
 */

import * as readline from "node:readline";

const { stores } = await import("../src/server/stores.ts");
const { vaultHandle } = await import("../src/server/vault/service.ts");
const { subscribe } = await import("../src/core/events.ts");
const { pluginTransport, pluginCoreData } = await import("../src/server/plugins.ts");
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");

const events: string[] = [];
subscribe((e) => events.push(e.type));

const ops: Record<string, (a: Record<string, unknown>) => unknown> = {
	deviceId: () => stores.deviceStore.getDevice().id,
	route: (a) => vaultHandle({ method: String(a.method), path: String(a.path), body: a.body }),
	createChat: (a) => stores.chatStore.createChat(String(a.title)).id,
	saveMessages: (a) => stores.chatStore.saveMessages(String(a.id), a.messages as never),
	renameChat: (a) => stores.chatStore.renameChat(String(a.id), String(a.title)),
	deleteChat: (a) => stores.chatStore.deleteChat(String(a.id)),
	chats: () => stores.chatStore.listChats().map((c) => ({ id: c.id, title: c.title })),
	messages: (a) => stores.chatStore.getChat(String(a.id))?.messages ?? null,
	events: () => events.splice(0),
	// Plugins through the app's transport, so the vault's plugin sync wraps enable and calls (ADR 0007).
	setPluginEnabled: (a) => plugin(pluginTransport.setEnabled(String(a.id), post({ enabled: a.enabled === true }))),
	pluginCall: async (a) => ((await plugin(pluginTransport.call(String(a.id), post({ operation: a.operation, input: a.input ?? {} })))) as { result: unknown }).result,
	/** A core plugin's data file as text, or null. */
	coreDataFile: (a) => {
		const file = join(pluginCoreData.directory, String(a.id), String(a.file));
		return existsSync(file) ? readFileSync(file, "utf8") : null;
	},
};

function post(body: unknown): Request {
	return new Request("http://localhost/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function plugin(response: Promise<Response>): Promise<unknown> {
	const r = await response;
	const body = (await r.json()) as unknown;
	if (!r.ok) throw new Error(`plugin request failed (${r.status}): ${JSON.stringify(body)}`);
	return body;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const { rid, op, ...args } = JSON.parse(line) as { rid: number; op: string } & Record<string, unknown>;
	void (async () => {
		try {
			const result = await (ops[op] ?? (() => Promise.reject(new Error(`unknown op ${op}`))))(args);
			process.stdout.write(`${JSON.stringify({ rid, ok: true, result })}\n`);
		} catch (e) {
			process.stdout.write(`${JSON.stringify({ rid, ok: false, error: String(e) })}\n`);
		}
	})();
});
