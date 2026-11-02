import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AndroidPasskeys } from "../src/server/vault/passkey-android.ts";
import { PASSKEY_PRF_SALT, PasskeyError } from "../src/server/vault/passkey-ipc.ts";

const b64u = (n: number, v = 1) => Buffer.alloc(n, v).toString("base64url");
const credential = (prf?: object) => ({
	id: "cred", rawId: "cred", type: "public-key",
	response: { clientDataJSON: "e30", attestationObject: "AA" },
	clientExtensionResults: { credProps: { rk: true }, ...(prf ? { prf } : {}) },
});

/** A fake of the shell's KeystoreServer passkey routes: records requests and answers with `reply`. */
function make(reply: (path: string, body: any) => { status?: number; json?: unknown }, o: { url?: string; secret?: string; serverUrl?: string | null } = {}) {
	const calls: { url: string; auth: string | null; body: any }[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		calls.push({ url, auth: new Headers(init.headers).get("authorization"), body });
		const r = reply(new URL(url).pathname, body);
		return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof globalThis.fetch;
	const pk = new AndroidPasskeys({
		url: "url" in o ? o.url : "http://127.0.0.1:4100", secret: "secret" in o ? o.secret : "s3cret",
		serverUrl: o.serverUrl === undefined ? "https://learn-vault.ddns.net" : o.serverUrl, fetch,
	});
	return { pk, calls };
}

const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof PasskeyError && e.code === code);

describe("AndroidPasskeys availability", () => {
	it("needs the shell's bridge and an https vault server, any host", () => {
		assert.deepEqual(make(() => ({})).pk.availability(), { available: true });
		assert.deepEqual(make(() => ({}), { url: undefined }).pk.availability(), { available: false, reason: "bridge_missing" });
		assert.deepEqual(make(() => ({}), { secret: undefined }).pk.availability(), { available: false, reason: "bridge_missing" });
		assert.deepEqual(make(() => ({}), { serverUrl: "http://192.168.0.4:8081" }).pk.availability(), { available: false, reason: "unsupported_server" });
		assert.deepEqual(make(() => ({}), { serverUrl: null }).pk.availability(), { available: false, reason: "unsupported_server" });
	});

	it("reads LH_PASSKEY_URL and LH_DESKTOP_API_SECRET", () => {
		assert.deepEqual(AndroidPasskeys.fromEnv({ LH_PASSKEY_URL: "http://127.0.0.1:1", LH_DESKTOP_API_SECRET: "x" }, "https://h.example").availability(), { available: true });
		assert.deepEqual(AndroidPasskeys.fromEnv({}, "https://h.example").availability(), { available: false, reason: "bridge_missing" });
	});
});

describe("AndroidPasskeys ceremonies", () => {
	it("posts the options and the PRF salt with the bearer secret, and strips the PRF output from the credential", async () => {
		const prf = b64u(32, 7);
		const { pk, calls } = make(() => ({ json: { ok: true, credential: credential({ enabled: true, results: { first: prf } }), prfOutput: prf, prfEnabled: true } }));
		const options = { publicKey: { challenge: "Y2g", rp: { id: "learn-vault.ddns.net" }, user: { id: "dQ" } } };
		const out = await pk.create(options, new Uint8Array([1, 2, 3]));
		assert.equal(calls[0]!.url, "http://127.0.0.1:4100/passkey/create");
		assert.equal(calls[0]!.auth, "Bearer s3cret");
		assert.deepEqual(calls[0]!.body, { options, prfSalt: "AQID" });
		assert.deepEqual(out.prfOutput, new Uint8Array(32).fill(7));
		assert.equal(out.prfEnabled, true);
		assert.doesNotMatch(JSON.stringify(out.credential), new RegExp(prf));
		assert.deepEqual((out.credential as any).clientExtensionResults, { credProps: { rk: true }, prf: { enabled: true } });
	});

	it("uses the unlock salt for get by default, and reports a passkey without PRF as sign-in only", async () => {
		const { pk, calls } = make(() => ({ json: { ok: true, credential: credential(), prfOutput: null, prfEnabled: false } }));
		const out = await pk.get({ challenge: "Y2g" });
		assert.equal(calls[0]!.url, "http://127.0.0.1:4100/passkey/get");
		assert.equal(calls[0]!.body.prfSalt, Buffer.from(PASSKEY_PRF_SALT).toString("base64url"));
		assert.equal(out.prfOutput, null);
		assert.equal(out.prfEnabled, false);
	});

	it("maps the shell's failures to route errors", async () => {
		const fail = (name: string) => make(() => ({ json: { ok: false, error: { name, message: name } } })).pk.get({ challenge: "Y2g" });
		await rejectsWith(fail("NotAllowedError"), "passkey_cancelled");
		await rejectsWith(fail("Busy"), "passkey_busy");
		await rejectsWith(fail("InvalidStateError"), "passkey_failed");
		await rejectsWith(make(() => ({ status: 404 })).pk.get({ challenge: "Y2g" }), "passkey_unavailable");
		await rejectsWith(make(() => ({ status: 401 })).pk.get({ challenge: "Y2g" }), "passkey_failed");
		await rejectsWith(make(() => ({}), { url: undefined }).pk.get({ challenge: "Y2g" }), "passkey_unavailable");
	});

	it("refuses a malformed credential or a PRF output that is not 32 bytes", async () => {
		await rejectsWith(make(() => ({ json: { ok: true, credential: { type: "public-key" }, prfOutput: null } })).pk.get({ challenge: "Y2g" }), "passkey_failed");
		await rejectsWith(make(() => ({ json: { ok: true, credential: credential(), prfOutput: b64u(16) } })).pk.get({ challenge: "Y2g" }), "passkey_failed");
	});
});
