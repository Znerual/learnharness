// Node fake of KeystoreServer.kt: same routes, status codes and blob layout, real AES-256-GCM
// with the same AAD, so the adapter is tested against the contract and not against a stub.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const AAD = Buffer.from("lhv1/device-secrets", "utf8");

export interface FakeKeystore {
	url: string;
	secret: string;
	/** "software" simulates a device without hardware-backed keys in a release build. */
	level: "strongbox" | "tee" | "software";
	debug: boolean;
	key: Buffer | null;
	calls: string[];
	close(): Promise<void>;
}

export async function startFakeKeystore(init: Partial<Pick<FakeKeystore, "level" | "debug" | "secret">> = {}): Promise<FakeKeystore> {
	const state = { level: init.level ?? "tee", debug: init.debug ?? false, secret: init.secret ?? randomBytes(32).toString("hex"), key: null as Buffer | null, calls: [] as string[] };
	const available = () => state.level !== "software" || state.debug;
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const send = (status: number, body: string) => { res.writeHead(status, { "content-type": status === 200 && !body.startsWith("{") ? "text/plain" : "application/json" }); res.end(body); };
			if (req.headers.authorization !== `Bearer ${state.secret}`) return send(401, JSON.stringify({ error: "unauthorized" }));
			const op = req.url?.replace("/keystore/", "") ?? "";
			if (req.method !== "POST" || !["status", "wrap", "unwrap", "delete"].includes(op)) return send(404, JSON.stringify({ error: "not_found" }));
			state.calls.push(op);
			const body = Buffer.concat(chunks).toString("utf8");
			if (op === "status") {
				return send(200, JSON.stringify(available() ? { available: true, level: state.level } : { available: false, level: state.level, reason: "software_only" }));
			}
			if (op === "delete") { state.key = null; return send(200, "{}"); }
			if (!available()) return send(503, JSON.stringify({ error: "unavailable", reason: "software_only" }));
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length === 0) return send(400, JSON.stringify({ error: "bad_body" }));
			const data = Buffer.from(body, "base64");
			if (op === "wrap") {
				state.key ??= randomBytes(32);
				const iv = randomBytes(12);
				const c = createCipheriv("aes-256-gcm", state.key, iv);
				c.setAAD(AAD);
				const ct = Buffer.concat([c.update(data), c.final()]);
				return send(200, Buffer.concat([Buffer.from([1]), iv, ct, c.getAuthTag()]).toString("base64"));
			}
			// unwrap
			if (data.length < 30 || data[0] !== 1) return send(400, JSON.stringify({ error: "bad_blob" }));
			if (!state.key) return send(409, JSON.stringify({ error: "key_missing" }));
			try {
				const d = createDecipheriv("aes-256-gcm", state.key, data.subarray(1, 13));
				d.setAAD(AAD);
				d.setAuthTag(data.subarray(data.length - 16));
				return send(200, Buffer.concat([d.update(data.subarray(13, data.length - 16)), d.final()]).toString("base64"));
			} catch {
				return send(409, JSON.stringify({ error: "corrupt" }));
			}
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return Object.assign(state, {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
	}) as FakeKeystore;
}
