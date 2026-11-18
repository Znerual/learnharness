import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";

const { flushVault } = createRequire(import.meta.url)("../electron/vault-flush.cjs") as {
	flushVault(o: { port: number; secret?: string | null; timeoutMs?: number }): Promise<void>;
};

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

function serve(handler: (req: IncomingMessage, body: string, answer: () => void) => void): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => { body += c; });
			req.on("end", () => handler(req, body, () => res.end("{}")));
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
	});
}

describe("vault flush before the desktop app quits", () => {
	it("posts Sync now to the local server with the per-launch secret and waits for the answer", async () => {
		const seen: { method?: string; url?: string; secret?: string | string[]; body?: string }[] = [];
		const port = await serve((req, body, answer) => {
			seen.push({ method: req.method, url: req.url, secret: req.headers["x-learnharness-desktop"], body });
			setTimeout(answer, 50);
		});
		const t0 = Date.now();
		await flushVault({ port, secret: "s".repeat(64), timeoutMs: 2000 });
		assert.ok(Date.now() - t0 >= 40, "it waited for the answer");
		assert.deepEqual(seen, [{ method: "POST", url: "/api/vault/sync/now", secret: "s".repeat(64), body: "{}" }]);
	});

	it("gives up after the timeout when the server does not answer", async () => {
		const port = await serve(() => { /* never answers */ });
		const t0 = Date.now();
		await flushVault({ port, secret: "x", timeoutMs: 150 });
		const waited = Date.now() - t0;
		assert.ok(waited >= 140 && waited < 1000, `waited ${waited} ms`);
	});

	it("resolves at once when nothing listens", async () => {
		const port = await serve(() => undefined);
		await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
		const t0 = Date.now();
		await flushVault({ port, timeoutMs: 2000 });
		assert.ok(Date.now() - t0 < 1000);
	});
});
