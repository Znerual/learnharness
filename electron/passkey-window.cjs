"use strict";
// Passkey ceremony host for the Electron fork (spike #3, part of issue #30).
//
// Why a window: WebAuthn only works on a real https origin under the RP id (not file://, not a
// custom scheme). A dedicated child BrowserWindow with its own in-memory session partition
// intercepts `https://<vault host>` with protocol.handle, serves the bundled passkey/passkey.html
// and passkey.js, and (optionally) forwards /api/* to the real server. Chromium then sees a normal
// https origin with the vault host as RP id; no certificate and no system browser are needed.
//
// Data flow (never touches the main UI renderer):
//   server process --{channel:"lh:passkey", id, op, options, prfSalt}--> main (this file)
//   main opens the window; passkey.js asks for the request through passkey-preload.cjs,
//   runs navigator.credentials.create/get with the PRF extension and hands back
//   {credential, prfOutput}; main strips PRF results from the credential and answers the
//   server process over the same child IPC channel. The PRF output goes straight to the process
//   that holds keys and is never uploaded.
//
// Everything that decides something is a pure function, tested in plain Node. electron is
// required lazily so this file can be loaded without it.

const fs = require("node:fs");
const path = require("node:path");

const CHANNEL = "lh:passkey";
const OPS = ["create", "get"];
const PARTITION = "lhv-passkey"; // no "persist:" prefix: in-memory, gone when the window closes
const TIMEOUT_MS = 120_000;
const MAX_OPTIONS_CHARS = 64 * 1024;
const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const STATIC = {
	"/": { file: "passkey.html", type: "text/html; charset=utf-8" },
	"/passkey.html": { file: "passkey.html", type: "text/html; charset=utf-8" },
	"/passkey.js": { file: "passkey.js", type: "text/javascript; charset=utf-8" },
};
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The passkey relying party id for a vault server URL: the server's host name (ADR 0004), which
 * the ceremony window serves as its own origin. Null for anything the window cannot serve or
 * WebAuthn does not accept as an RP id (http, a port, an IP address, localhost, a bare name):
 * the desktop app then offers no passkey for that server. src/server/vault/passkey-ipc.ts holds
 * the same rule for the server process; tests/vault-passkey-window.test.ts keeps them equal.
 */
function passkeyHost(vaultUrl) {
	let u;
	try { u = new URL(String(vaultUrl)); } catch { return null; }
	if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
	const h = u.hostname;
	// at least two labels, and the last starts with a letter (so no IPv4 address)
	if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(h)) return null;
	if (h === "localhost" || h.endsWith(".localhost")) return null;
	return h;
}

/**
 * What to do with one request the ceremony window makes. Only the single vault host is answered
 * here; everything else is denied so the window can never load remote script.
 * @returns {{kind: "static", file: string, type: string} | {kind: "api", url: string} | {kind: "deny", status: number}}
 */
function routeRequest(urlString, method, { host, apiBase }) {
	let u;
	try { u = new URL(urlString); } catch { return { kind: "deny", status: 400 }; }
	if (u.protocol !== "https:" || u.hostname !== host || u.port !== "" || u.username || u.password) return { kind: "deny", status: 403 };
	const p = u.pathname;
	if (p.includes("\\") || p.includes("%") || p.split("/").some((s) => s === ".." || s === ".")) return { kind: "deny", status: 400 };
	if (Object.hasOwn(STATIC, p)) {
		if (method !== "GET" && method !== "HEAD") return { kind: "deny", status: 405 };
		return { kind: "static", ...STATIC[p] };
	}
	if (p.startsWith("/api/")) {
		if (!apiBase) return { kind: "deny", status: 404 };
		if (!API_METHODS.includes(method)) return { kind: "deny", status: 405 };
		return { kind: "api", url: apiBase.replace(/\/+$/, "") + p + u.search };
	}
	return { kind: "deny", status: 404 };
}

/** Validates a request from the server process. Returns an error string or null. */
function validateCeremonyRequest(m) {
	if (!m || typeof m !== "object" || m.channel !== CHANNEL) return "channel";
	if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > 64) return "id";
	if (!OPS.includes(m.op)) return "op";
	if (!m.options || typeof m.options !== "object" || Array.isArray(m.options)) return "options";
	let size;
	try { size = JSON.stringify(m.options).length; } catch { return "options"; }
	if (size > MAX_OPTIONS_CHARS) return "options";
	// The server may wrap options as {publicKey: {...}} (go-webauthn) or send the bare object.
	const pk = m.options.publicKey ?? m.options;
	if (!pk || typeof pk !== "object" || typeof pk.challenge !== "string" || !B64URL.test(pk.challenge)) return "challenge";
	if (m.op === "create" && (!pk.rp || typeof pk.rp !== "object" || !pk.user || typeof pk.user !== "object")) return "create options";
	if (typeof m.prfSalt !== "string" || !B64URL.test(m.prfSalt) || m.prfSalt.length > 128) return "prfSalt";
	return null;
}

/** Removes the PRF results from a credential's client extension results (never uploaded). */
function stripPrfResults(credential) {
	const out = { ...credential };
	const ext = credential.clientExtensionResults;
	if (ext && typeof ext === "object") {
		const { prf, ...rest } = ext;
		out.clientExtensionResults = prf && typeof prf === "object" ? { ...rest, prf: { enabled: prf.enabled === true } } : rest;
	}
	return out;
}

/**
 * Validates what the page sends back and normalises it. Page-reported failures keep their name
 * so the server process can tell a cancelled prompt from a real error.
 * @returns {{ok: true, value: {credential: object, prfOutput: string | null, prfEnabled: boolean}} | {ok: false, error: {name: string, message: string}}}
 */
function sanitizePageResult(r) {
	const bad = (message) => ({ ok: false, error: { name: "InvalidResult", message } });
	if (!r || typeof r !== "object") return bad("not an object");
	if (r.ok === false) {
		const e = r.error || {};
		return { ok: false, error: { name: typeof e.name === "string" ? e.name.slice(0, 64) : "Error", message: typeof e.message === "string" ? e.message.slice(0, 200) : "" } };
	}
	if (r.ok !== true) return bad("ok");
	const c = r.credential;
	if (!c || typeof c !== "object" || c.type !== "public-key") return bad("credential");
	if (typeof c.id !== "string" || !B64URL.test(c.id) || typeof c.rawId !== "string" || !B64URL.test(c.rawId)) return bad("credential id");
	if (!c.response || typeof c.response !== "object" || typeof c.response.clientDataJSON !== "string") return bad("credential response");
	let prfOutput = null;
	if (r.prfOutput !== null && r.prfOutput !== undefined) {
		if (typeof r.prfOutput !== "string" || !B64URL.test(r.prfOutput) || Buffer.from(r.prfOutput, "base64url").length !== 32) return bad("prfOutput must be 32 bytes");
		prfOutput = r.prfOutput;
	}
	return { ok: true, value: { credential: stripPrfResults(c), prfOutput, prfEnabled: r.prfEnabled === true || prfOutput !== null } };
}

/** Main-process ceremony runner. One ceremony at a time. */
function createPasskeyCeremony({ host, apiBase, parent, timeoutMs = TIMEOUT_MS }) {
	// `parent` may be a function: the main window does not exist yet when the service is created.
	const { BrowserWindow, ipcMain, net, session } = require("electron");
	const origin = `https://${host}`;
	let active = null; // {win, request, settle}

	const ses = session.fromPartition(PARTITION);
	ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
	ses.protocol.handle("https", async (request) => {
		const route = routeRequest(request.url, request.method, { host, apiBase });
		if (route.kind === "deny") return new Response("", { status: route.status });
		if (route.kind === "static") {
			const body = fs.readFileSync(path.join(__dirname, "passkey", route.file));
			return new Response(request.method === "HEAD" ? null : body, {
				headers: {
					"content-type": route.type,
					"cache-control": "no-store",
					"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
				},
			});
		}
		// Forward to the real API. No cookies, no ambient credentials; the page only sends what it was given.
		const headers = new Headers();
		for (const h of ["content-type", "authorization"]) if (request.headers.has(h)) headers.set(h, request.headers.get(h));
		return net.fetch(route.url, {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
			bypassCustomProtocolHandlers: true,
		});
	});

	const trusted = (event) => {
		if (!active || event.sender !== active.win.webContents) return false;
		try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
	};
	ipcMain.handle("lh:passkey:request", (event) => (trusted(event) ? active.request : null));
	ipcMain.handle("lh:passkey:finish", (event, result) => {
		if (!trusted(event)) return false;
		active.settle(sanitizePageResult(result));
		return true;
	});

	return {
		/** @returns {Promise<{ok: true, value: object} | {ok: false, error: {name: string, message: string}}>} */
		run(request) {
			const bad = validateCeremonyRequest(request);
			if (bad) return Promise.resolve({ ok: false, error: { name: "InvalidRequest", message: bad } });
			if (active) return Promise.resolve({ ok: false, error: { name: "Busy", message: "another passkey ceremony is running" } });
			return new Promise((resolve) => {
				const owner = typeof parent === "function" ? parent() : parent;
				const modalParent = owner && !owner.isDestroyed() ? owner : undefined;
				const win = new BrowserWindow({
					width: 460, height: 360, title: "Passkey", ...(modalParent ? { parent: modalParent, modal: true } : {}), show: true, autoHideMenuBar: true,
					webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: path.join(__dirname, "passkey-preload.cjs") },
				});
				let done = false;
				const timer = setTimeout(() => settle({ ok: false, error: { name: "Timeout", message: "passkey ceremony timed out" } }), timeoutMs);
				function settle(result) {
					if (done) return;
					done = true;
					clearTimeout(timer);
					active = null;
					if (!win.isDestroyed()) win.destroy();
					resolve(result);
				}
				active = { win, request: { op: request.op, options: request.options.publicKey ?? request.options, prfSalt: request.prfSalt }, settle };
				win.webContents.on("will-navigate", (e) => e.preventDefault());
				win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
				win.on("closed", () => settle({ ok: false, error: { name: "NotAllowedError", message: "window closed" } }));
				win.loadURL(`${origin}/`).catch((e) => settle({ ok: false, error: { name: "LoadError", message: String(e && e.message) } }));
			});
		},
	};
}

/** Wires `lh:passkey` for one server child, like attachKeyStorageChild. */
function attachPasskeyChild(child, ceremony) {
	let disposed = false;
	const send = (packet) => { if (!disposed && child.connected) { try { child.send(packet, () => {}); } catch { /* child exited */ } } };
	const listener = async (message) => {
		if (disposed || !message || message.channel !== CHANNEL) return;
		const bad = validateCeremonyRequest(message);
		if (bad) {
			if (typeof message.id === "string") send({ channel: CHANNEL, id: message.id, op: message.op, ok: false, error: { name: "InvalidRequest", message: bad } });
			return;
		}
		const res = await ceremony.run(message);
		send(res.ok ? { channel: CHANNEL, id: message.id, op: message.op, ok: true, value: res.value } : { channel: CHANNEL, id: message.id, op: message.op, ok: false, error: res.error });
	};
	child.on("message", listener);
	return { dispose() { disposed = true; child.removeListener("message", listener); } };
}

module.exports = { CHANNEL, PARTITION, passkeyHost, routeRequest, validateCeremonyRequest, sanitizePageResult, stripPrfResults, createPasskeyCeremony, attachPasskeyChild };
