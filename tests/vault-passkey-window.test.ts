import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { passkeyDomain as serverPasskeyDomain } from "../src/server/vault/passkey-ipc.ts";
import { attachPasskeyChild, passkeyDomain, routeRequest, sanitizePageResult, stripPrfResults, validateCeremonyRequest } from "../electron/passkey-window.cjs";

const o = { domain: "example.test", apiBase: "https://api.internal.test" };
const b64u = (n: number, v = 1) => Buffer.alloc(n, v).toString("base64url");

describe("routeRequest", () => {
	it("serves the bundled files on the vault host", () => {
		assert.deepEqual(routeRequest("https://vault.example.test/", "GET", o), { kind: "static", file: "passkey.html", type: "text/html; charset=utf-8" });
		assert.equal((routeRequest("https://vault.example.test/passkey.js", "GET", o) as any).file, "passkey.js");
		assert.equal((routeRequest("https://vault.example.test/passkey.html?x=1", "GET", o) as any).file, "passkey.html");
	});
	it("forwards /api/* with method, path and query to the configured base", () => {
		assert.deepEqual(routeRequest("https://vault.example.test/api/v1/x?y=2", "POST", o), { kind: "api", url: "https://api.internal.test/api/v1/x?y=2" });
		assert.equal(routeRequest("https://vault.example.test/api/v1/x", "TRACE", o).kind, "deny");
		assert.equal(routeRequest("https://vault.example.test/api/v1/x", "GET", { domain: "example.test" }).kind, "deny");
	});
	it("denies other hosts, schemes, ports, credentials and traversal", () => {
		for (const u of [
			"https://evil.test/", "https://example.test/", "https://vault.example.test.evil.test/", "http://vault.example.test/",
			"https://vault.example.test:8443/", "https://user@vault.example.test/", "https://vault.example.test/api/../other.js",
			"https://vault.example.test/%2e%2e/secret", "https://vault.example.test/other.js", "not a url",
		]) assert.equal(routeRequest(u, "GET", o).kind, "deny", u);
	});
	it("does not serve static files for write methods", () => {
		assert.deepEqual(routeRequest("https://vault.example.test/", "POST", o), { kind: "deny", status: 405 });
	});
});

const req = (extra: object = {}) => ({ channel: "lh:passkey", id: "1", op: "get", options: { publicKey: { challenge: b64u(32) } }, prfSalt: b64u(19), ...extra });

describe("validateCeremonyRequest", () => {
	it("accepts get and create, wrapped or bare options", () => {
		assert.equal(validateCeremonyRequest(req()), null);
		assert.equal(validateCeremonyRequest(req({ options: { challenge: b64u(32) } })), null);
		assert.equal(validateCeremonyRequest(req({ op: "create", options: { publicKey: { challenge: b64u(32), rp: { name: "x" }, user: { id: "a", name: "n" } } } })), null);
	});
	it("rejects malformed requests", () => {
		assert.equal(validateCeremonyRequest(null), "channel");
		assert.equal(validateCeremonyRequest(req({ channel: "x" })), "channel");
		assert.equal(validateCeremonyRequest(req({ id: "" })), "id");
		assert.equal(validateCeremonyRequest(req({ op: "delete" })), "op");
		assert.equal(validateCeremonyRequest(req({ options: [] })), "options");
		assert.equal(validateCeremonyRequest(req({ options: { challenge: "not base64!" } })), "challenge");
		assert.equal(validateCeremonyRequest(req({ op: "create" })), "create options");
		assert.equal(validateCeremonyRequest(req({ prfSalt: "a b" })), "prfSalt");
		assert.equal(validateCeremonyRequest(req({ options: { publicKey: { challenge: b64u(32), pad: "x".repeat(70000) } } })), "options");
	});
});

const cred = (ext: unknown = { prf: { enabled: true, results: { first: b64u(32) } } }) => ({
	id: b64u(16), rawId: b64u(16), type: "public-key", response: { clientDataJSON: b64u(10) }, clientExtensionResults: ext,
});

describe("sanitizePageResult", () => {
	it("strips PRF results from the credential and passes the 32-byte output separately", () => {
		const r = sanitizePageResult({ ok: true, credential: cred(), prfOutput: b64u(32, 9), prfEnabled: true });
		assert.ok(r.ok);
		assert.deepEqual(r.value.credential["clientExtensionResults"], { prf: { enabled: true } });
		assert.equal(r.value.prfOutput, b64u(32, 9));
		assert.ok(!JSON.stringify(r.value.credential).includes(b64u(32)));
	});
	it("accepts a missing PRF output (sign-in only passkey)", () => {
		const r = sanitizePageResult({ ok: true, credential: cred({}), prfOutput: null, prfEnabled: false });
		assert.ok(r.ok && r.value.prfOutput === null && r.value.prfEnabled === false);
	});
	it("rejects a PRF output that is not 32 bytes, or a bad credential", () => {
		for (const bad of [
			{ ok: true, credential: cred(), prfOutput: b64u(16) },
			{ ok: true, credential: cred(), prfOutput: 5 },
			{ ok: true, credential: { ...cred(), type: "password" }, prfOutput: null },
			{ ok: true, credential: { ...cred(), id: "!!" }, prfOutput: null },
			{ ok: true, credential: { ...cred(), response: {} }, prfOutput: null },
			{ ok: "yes" }, null,
		]) {
			const r = sanitizePageResult(bad);
			assert.equal(r.ok, false);
		}
	});
	it("passes page-reported errors through, truncated", () => {
		const r = sanitizePageResult({ ok: false, error: { name: "NotAllowedError", message: "x".repeat(500) } });
		assert.ok(!r.ok);
		assert.equal(r.error.name, "NotAllowedError");
		assert.equal(r.error.message.length, 200);
	});
	it("stripPrfResults keeps other extension results", () => {
		assert.deepEqual(stripPrfResults({ clientExtensionResults: { credProps: { rk: true }, prf: { enabled: true, results: { first: "x" } } } }).clientExtensionResults, { credProps: { rk: true }, prf: { enabled: true } });
	});
});

describe("attachPasskeyChild", () => {
	function fakeChild() {
		const ee = new EventEmitter() as EventEmitter & { connected: boolean; sent: any[]; send(m: unknown, cb?: () => void): void };
		ee.connected = true; ee.sent = [];
		ee.send = (m) => { ee.sent.push(m); };
		return ee;
	}
	it("relays a ceremony result and an invalid request error", async () => {
		const child = fakeChild();
		const calls: unknown[] = [];
		attachPasskeyChild(child, { run: async (r) => { calls.push(r); return { ok: true, value: { prfOutput: null } }; } });
		child.emit("message", req());
		child.emit("message", req({ id: "2", op: "nope" }));
		child.emit("message", { channel: "lh:other", id: "3" });
		await new Promise((r) => setImmediate(r));
		assert.equal(calls.length, 1);
		const byId = (id: string) => child.sent.find((m) => m.id === id);
		assert.deepEqual(byId("1"), { channel: "lh:passkey", id: "1", op: "get", ok: true, value: { prfOutput: null } });
		assert.equal(byId("2").ok, false);
		assert.equal(byId("2").error.name, "InvalidRequest");
		assert.equal(child.sent.length, 2);
	});
});

describe("passkeyDomain", () => {
	const cases: [string, string | null][] = [
		["https://vault.example.org", "example.org"],
		["https://vault.learn.example.org/", "learn.example.org"],
		["https://vault.example.org/api", "example.org"],
		["https://example.org", null],
		["https://vault.localhost", null],
		["http://vault.example.org", null],
		["https://vault.example.org:8443", null],
		["https://evilvault.example.org", null],
		["https://vault.1.2.3.4", null],
		["http://localhost:8080", null],
		["not a url", null],
		["", null],
	];
	it("takes the domain from vault.<domain>, in the main process and the server process alike", () => {
		for (const [url, want] of cases) {
			assert.equal(passkeyDomain(url), want, url);
			assert.equal(serverPasskeyDomain(url), want, `server: ${url}`);
		}
	});
});
