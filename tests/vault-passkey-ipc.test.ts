import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { IpcPasskeys, PASSKEY_PRF_SALT, PasskeyError } from "../src/server/vault/passkey-ipc.ts";
import type { IpcProcess } from "../src/server/vault/keystorage-ipc.ts";

/** A fake of the server child's `process`: records what is sent, lets the test play the Electron main side. */
function fakeProc(connected = true) {
	const ee = new EventEmitter();
	const sent: Record<string, any>[] = [];
	const proc = Object.assign(ee, {
		connected,
		send: (m: Record<string, any>, cb?: (e: Error | null) => void) => {
			sent.push(m);
			cb?.(null);
			return true;
		},
	}) as unknown as IpcProcess & EventEmitter;
	const reply = (id: string, rest: object) => proc.emit("message", { channel: "lh:passkey", id, ...rest });
	return { proc, sent, reply };
}

const b64u = (n: number, v = 1) => Buffer.alloc(n, v).toString("base64url");
const URL_OK = "https://vault.example.org";

function make(o: { connected?: boolean; desktop?: boolean; serverUrl?: string | null; timeoutMs?: number } = {}) {
	const f = fakeProc(o.connected ?? true);
	const ipc = new IpcPasskeys({ proc: f.proc, desktop: o.desktop ?? true, serverUrl: o.serverUrl === undefined ? URL_OK : o.serverUrl, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
	return { ...f, ipc };
}

describe("IpcPasskeys availability", () => {
	it("is available only in the desktop server child, with a connected channel and a vault.<domain> server", () => {
		assert.deepEqual(make().ipc.availability(), { available: true });
		assert.deepEqual(make({ desktop: false }).ipc.availability(), { available: false, reason: "bridge_missing" });
		assert.deepEqual(make({ connected: false }).ipc.availability(), { available: false, reason: "bridge_missing" });
		assert.deepEqual(make({ serverUrl: "http://localhost:8080" }).ipc.availability(), { available: false, reason: "unsupported_server" });
		assert.deepEqual(make({ serverUrl: null }).ipc.availability(), { available: false, reason: "unsupported_server" });
	});
	it("refuses a ceremony without sending anything when unavailable", async () => {
		const m = make({ desktop: false });
		await assert.rejects(m.ipc.get({ challenge: "x" }), (e: PasskeyError) => e.code === "passkey_unavailable");
		assert.equal(m.sent.length, 0);
	});
});

describe("IpcPasskeys ceremonies", () => {
	it("sends get with the default unlock salt and returns the decoded PRF output", async () => {
		const m = make();
		const p = m.ipc.get({ publicKey: { challenge: b64u(32) } });
		assert.equal(m.sent.length, 1);
		const req = m.sent[0]!;
		assert.deepEqual([req["channel"], req["op"]], ["lh:passkey", "get"]);
		assert.equal(req["prfSalt"], Buffer.from(PASSKEY_PRF_SALT).toString("base64url"));
		m.reply(req["id"], { op: "get", ok: true, value: { credential: { id: "c" }, prfOutput: b64u(32, 9), prfEnabled: true } });
		const r = await p;
		assert.deepEqual(r.credential, { id: "c" });
		assert.deepEqual([...(r.prfOutput ?? [])], new Array(32).fill(9));
		assert.equal(r.prfEnabled, true);
	});
	it("sends create with the server's salt; a key without PRF gives a null output", async () => {
		const m = make();
		const p = m.ipc.create({ rp: {}, user: {}, challenge: b64u(32) }, new Uint8Array([1, 2, 3]));
		const req = m.sent[0]!;
		assert.equal(req["op"], "create");
		assert.equal(req["prfSalt"], Buffer.from([1, 2, 3]).toString("base64url"));
		m.reply(req["id"], { ok: true, value: { credential: {}, prfOutput: null, prfEnabled: false } });
		const r = await p;
		assert.equal(r.prfOutput, null);
		assert.equal(r.prfEnabled, false);
	});
	it("maps a closed window to passkey_cancelled, a running ceremony to passkey_busy, anything else to passkey_failed", async () => {
		for (const [name, code] of [["NotAllowedError", "passkey_cancelled"], ["Busy", "passkey_busy"], ["InvalidResult", "passkey_failed"], ["Timeout", "passkey_failed"]] as const) {
			const m = make();
			const p = m.ipc.get({});
			m.reply(m.sent[0]!["id"], { ok: false, error: { name, message: "x" } });
			await assert.rejects(p, (e: PasskeyError) => e.code === code, name);
		}
	});
	it("rejects a PRF output that is not 32 bytes", async () => {
		const m = make();
		const p = m.ipc.get({});
		m.reply(m.sent[0]!["id"], { ok: true, value: { credential: {}, prfOutput: b64u(16), prfEnabled: true } });
		await assert.rejects(p, (e: PasskeyError) => e.code === "passkey_failed");
	});
	it("ignores other channels and unknown ids, and matches replies by id", async () => {
		const m = make();
		const a = m.ipc.get({});
		const b = m.ipc.get({});
		m.proc.emit("message", { channel: "lh:keystorage", id: m.sent[0]!["id"], ok: true, value: {} });
		m.reply("nope", { ok: true, value: { credential: {}, prfOutput: null } });
		m.reply(m.sent[1]!["id"], { ok: true, value: { credential: { n: 2 }, prfOutput: null } });
		m.reply(m.sent[0]!["id"], { ok: true, value: { credential: { n: 1 }, prfOutput: null } });
		assert.deepEqual((await a).credential, { n: 1 });
		assert.deepEqual((await b).credential, { n: 2 });
	});
	it("times out when the main process never answers, and fails pending requests when the channel closes", async () => {
		const slow = make({ timeoutMs: 20 });
		await assert.rejects(slow.ipc.get({}), (e: PasskeyError) => e.code === "passkey_failed" && /timed out/.test(e.message));
		const m = make();
		const p = m.ipc.get({});
		m.proc.emit("disconnect");
		await assert.rejects(p, (e: PasskeyError) => e.code === "passkey_failed");
	});
});
