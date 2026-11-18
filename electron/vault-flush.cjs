"use strict";
/**
 * Before the desktop app quits, the server child gets a short chance to upload
 * what the vault has not sent yet, plugin files included (ADR 0007: plugin
 * files are flushed at shutdown, past their 60 s upload interval). The quit
 * never waits longer than `timeoutMs`; an unfinished upload goes out at the
 * next start. Without a vault (or signed out) the server answers at once.
 */
const http = require("node:http");

const VAULT_FLUSH_TIMEOUT_MS = 2000;

/**
 * POST /api/vault/sync/now on the local server. Resolves (never rejects) on
 * the answer, an error or the timeout, whichever comes first.
 */
function flushVault({ port, secret, timeoutMs = VAULT_FLUSH_TIMEOUT_MS, request = http.request }) {
	return new Promise((resolve) => {
		let done = false;
		let req = null;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				req?.destroy();
			} catch {
				/* already closed */
			}
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		try {
			req = request(
				{
					host: "127.0.0.1",
					port: Number(port),
					path: "/api/vault/sync/now",
					method: "POST",
					headers: { "content-type": "application/json", "content-length": 2, ...(secret ? { "x-learnharness-desktop": secret } : {}) },
				},
				(res) => {
					res.resume();
					res.on("end", finish);
					res.on("error", finish);
				},
			);
			req.on("error", finish);
			req.end("{}");
		} catch {
			finish();
		}
	});
}

module.exports = { flushVault, VAULT_FLUSH_TIMEOUT_MS };
