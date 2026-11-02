/**
 * The vault end to end, through the app's own wiring: two LearnHarness data folders (two child
 * processes running src/server/stores.ts and the vault routes) sign in to a real vault server and
 * sync a session through the wrapped stores. Needs the private vault repo and Postgres:
 *
 *   LHV_REPO=/path/to/learnharness-vault          (builds ./server/cmd/lhv-server with Go)
 *   LHV_TEST_DATABASE_URL=postgres://lhv:lhv@localhost:55432/postgres?sslmode=disable
 *   GOTOOLCHAIN=go1.26.0                           (optional; that is the default here)
 *
 * Skipped when either variable is missing or the vault client package is not installed.
 *
 * Against a deployed vault instead (no Go, no Postgres; signup codes come from its Mailpit API):
 *
 *   LH_VAULT_E2E_REMOTE_URL=https://learn-vault.ddns.net
 *   LH_VAULT_E2E_MAIL_URL=https://pi-wordextremist.local/mail   LH_VAULT_E2E_MAIL_AUTH=vault:<password>
 *   NODE_EXTRA_CA_CERTS=<root.crt>                 (when either URL uses a private CA)
 *
 * Remote runs use fresh addresses (e2e-a+<run>@example.org) and leave the accounts on the server.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { after, before, describe, test } from "node:test";

import { hasVaultClient } from "./vault-helpers.ts";

const DB_URL = process.env.LHV_TEST_DATABASE_URL;
const REPO = process.env.LHV_REPO;
const REMOTE = process.env.LH_VAULT_E2E_REMOTE_URL?.replace(/\/+$/, "");
const MAIL_URL = process.env.LH_VAULT_E2E_MAIL_URL?.replace(/\/+$/, "");
const MAIL_AUTH = process.env.LH_VAULT_E2E_MAIL_AUTH;
const RUN = Date.now().toString(36);
const skip = !hasVaultClient
	? "the vault client package is not installed"
	: REMOTE
		? !MAIL_URL || !MAIL_AUTH ? "LH_VAULT_E2E_MAIL_URL and LH_VAULT_E2E_MAIL_AUTH are needed with LH_VAULT_E2E_REMOTE_URL" : false
		: !DB_URL ? "LHV_TEST_DATABASE_URL is not set" : !REPO ? "LHV_REPO is not set" : false;

/** A test address; unique per run against a deployed vault, where accounts stay. */
const addr = (local: string) => (REMOTE ? `${local}+${RUN}@example.org` : `${local}@example.org`);

const ROOT = join(import.meta.dirname, "..");
const PASSWORD = "correct horse battery staple, but longer";

// pg comes from the vault checkout (the fork has no database dependency of its own).
type PgClient = { connect(): Promise<void>; query<T = unknown>(q: string, a?: unknown[]): Promise<{ rows: T[] }>; end(): Promise<void> };
type PgModule = { default: { Client: new (o: { connectionString: string }) => PgClient } } | { Client: new (o: { connectionString: string }) => PgClient };

describe("vault end to end: two data folders sync a session through the wired stores", { skip }, () => {
	let tmp: string;
	let server: ChildProcess;
	let admin: PgClient;
	let db: PgClient;
	let dbName: string;
	let serverUrl: string;
	const children: Device[] = [];

	before(async () => {
		tmp = mkdtempSync(join(tmpdir(), "lh-vault-e2e-"));
		if (REMOTE) {
			serverUrl = REMOTE;
			return;
		}
		const pgModule = createRequire(join(REPO as string, "client", "package.json"))("pg") as PgModule;
		const Client = "Client" in pgModule ? pgModule.Client : pgModule.default.Client;
		const bin = join(tmp, "lhv-server");
		execFileSync("go", ["build", "-o", bin, "./server/cmd/lhv-server"], { cwd: REPO as string, env: { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "go1.26.0" }, stdio: "inherit" });
		dbName = `lh_vault_e2e_${process.pid}_${Date.now()}`;
		admin = new Client({ connectionString: DB_URL as string });
		await admin.connect();
		await admin.query(`CREATE DATABASE ${dbName}`);
		const dbUrl = new URL(DB_URL as string);
		dbUrl.pathname = `/${dbName}`;
		const port = 20000 + Math.floor(Math.random() * 20000);
		serverUrl = `http://localhost:${port}`;
		server = spawn(bin, [], {
			env: {
				...process.env, LHV_DATABASE_URL: dbUrl.toString(), LHV_PUBLIC_URL: serverUrl, LHV_LISTEN: `127.0.0.1:${port}`, LHV_METRICS_LISTEN: "127.0.0.1:0",
				LHV_BLOB_ROOT: join(tmp, "blobs"), LHV_SECRETS_FILE: join(tmp, "secrets.json"), LHV_SERVER_IDENTITY: "vault.e2e", LHV_DISABLE_RATE_LIMITS: "true", LHV_DEFAULT_QUOTA_BYTES: "50000000",
			},
			stdio: "ignore",
		});
		for (let i = 0; ; i++) {
			try {
				if ((await fetch(`${serverUrl}/healthz`)).ok) break;
			} catch {
				// not up yet
			}
			if (i > 200 || server.exitCode !== null) throw new Error("lhv-server did not start");
			await new Promise((r) => setTimeout(r, 50));
		}
		db = new Client({ connectionString: dbUrl.toString() });
		await db.connect();
	});

	after(async () => {
		for (const c of children) c.close();
		server?.kill("SIGTERM");
		await db?.end();
		await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
		await admin?.end();
		if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
	});

	async function signupCode(email: string): Promise<string> {
		if (REMOTE) return remoteSignupCode(email);
		const r = await db.query<{ body_text: string }>("SELECT body_text FROM mail_queue WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [email]);
		const m = /\n\s+([0-9A-Z]{8})\n/.exec(r.rows[0]?.body_text ?? "");
		if (!m) throw new Error(`no signup code mailed to ${email}`);
		return (m[1] as string).toLowerCase();
	}

	function device(name: string): Device {
		const d = new Device(join(tmp, name), serverUrl);
		children.push(d);
		return d;
	}

	const message = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

	test("sign up on the first device seeds its folder, a second device signs in, sessions flow both ways", async () => {
		const a = device("desktop");
		const b = device("phone");
		assert.equal((await a.route("GET", "/available")).status, 200);
		assert.deepEqual((await a.route("GET", "/available")).body, { available: true });

		// Data from before the vault: a session on the first device.
		const old = (await a.call("createChat", { title: "Before the vault" })) as string;
		await a.call("saveMessages", { id: old, messages: [message("hello from before")] });

		// Sign up on A through the real routes; the stores switch to the wrapped ones.
		const email = addr("e2e-a");
		assert.equal((await a.route("POST", "/signup/start", { email })).status, 200);
		assert.equal((await a.route("POST", "/signup/verify", { email, code: await signupCode(email) })).status, 200);
		const finish = await a.route("POST", "/signup/finish", { password: PASSWORD });
		assert.equal(finish.status, 200, JSON.stringify(finish.body));
		assert.equal(((await a.route("GET", "/session")).body as { state: string }).state, "signed_in");

		// New work on A goes through the wrapped stores: no manual notes anywhere.
		const fresh = (await a.call("createChat", { title: "Photosynthesis" })) as string;
		await a.call("saveMessages", { id: fresh, messages: [message("what is chlorophyll?")] });
		await a.call("renameChat", { id: fresh, title: "Photosynthesis, revised" });
		assert.equal((await a.route("POST", "/sync/now")).status, 200);

		// B signs in to the same account with an empty folder and syncs.
		assert.equal((await b.route("POST", "/sign-in/password", { email, password: PASSWORD })).status, 200);
		assert.equal((await b.route("POST", "/sync/now")).status, 200);
		const onB = (await b.call("chats")) as { id: string; title: string }[];
		assert.deepEqual(onB.map((c) => c.title).sort(), ["Before the vault", "Photosynthesis, revised"]);
		assert.deepEqual(await b.call("messages", { id: fresh }), await a.call("messages", { id: fresh }));
		assert.ok(((await b.call("events")) as string[]).includes("chats-changed"), "open views are told about the pulled sessions");

		// And back: B continues the session and starts another one.
		await b.call("saveMessages", { id: fresh, messages: [message("what is chlorophyll?"), message("a green pigment")] });
		const second = (await b.call("createChat", { title: "From the phone" })) as string;
		assert.equal((await b.route("POST", "/sync/now")).status, 200);
		assert.equal((await a.route("POST", "/sync/now")).status, 200);
		const onA = (await a.call("chats")) as { id: string; title: string }[];
		assert.ok(onA.some((c) => c.id === second), "the phone's session reached the desktop");
		assert.equal(((await a.call("messages", { id: fresh })) as unknown[]).length, 2);

		// Status, then sign out of the vault: the stores are plain again and keep working.
		const status = (await a.route("GET", "/sync/status")).body as { state: string; pendingChanges: number };
		assert.equal(status.pendingChanges, 0);
		assert.equal((await a.route("POST", "/session/sign-out")).status, 200);
		assert.ok(await a.call("createChat", { title: "After sign-out" }));
	});

	test("a first sign-in with local data into a vault with data asks first; cancel changes nothing, \"Use the vault\" moves the files aside", async () => {
		const a = device("owner");
		const email = addr("e2e-join");
		await a.route("POST", "/signup/start", { email });
		await a.route("POST", "/signup/verify", { email, code: await signupCode(email) });
		assert.equal((await a.route("POST", "/signup/finish", { password: PASSWORD })).status, 200);
		const theirs = (await a.call("createChat", { title: "Owner session" })) as string;
		await a.call("saveMessages", { id: theirs, messages: [message("owner data")] });
		assert.equal((await a.route("POST", "/sync/now")).status, 200);

		// A second device with a session of its own, from before the vault.
		const b = device("laptop-with-data");
		const mine = (await b.call("createChat", { title: "Local only" })) as string;
		await b.call("saveMessages", { id: mine, messages: [message("local data")] });
		const joining = await b.route("POST", "/sign-in/password", { email, password: PASSWORD });
		assert.equal(joining.status, 200);
		const dto = joining.body as { state: string; email: string; localFiles: number };
		assert.deepEqual([dto.state, dto.email], ["joining", email]);
		assert.ok(dto.localFiles > 0);
		assert.equal(((await b.route("GET", "/session")).body as { state: string }).state, "joining");
		assert.deepEqual(((await b.call("chats")) as { id: string }[]).map((c) => c.id), [mine], "nothing moved while the question is open");

		// Cancel: signed out, the local session is untouched, nothing was uploaded.
		assert.deepEqual((await b.route("POST", "/session/join", { choice: "cancel" })).body, { state: "signed_out" });
		assert.deepEqual(((await b.call("chats")) as { id: string }[]).map((c) => c.id), [mine]);
		assert.equal(b.listMoved().length, 0);

		// Sign in again and use the vault: the local files move to pre-vault-<date>/, the vault's data arrives.
		assert.equal(((await b.route("POST", "/sign-in/password", { email, password: PASSWORD })).body as { state: string }).state, "joining");
		assert.equal(((await b.route("POST", "/session/join", { choice: "use-vault" })).body as { state: string }).state, "signed_in");
		assert.equal((await b.route("POST", "/sync/now")).status, 200);
		assert.deepEqual(((await b.call("chats")) as { id: string }[]).map((c) => c.id), [theirs]);
		assert.ok(b.listMoved().some((f) => f.endsWith(`${mine}.json`)), `the local session is kept in pre-vault-<date>/: ${b.listMoved().join(", ")}`);
	});

	test("a data folder shared with Syncthing is refused before the vault is enabled", async () => {
		const c = device("syncthing");
		c.markSyncthing();
		const r = await c.route("POST", "/signup/start", { email: addr("e2e-st") });
		assert.equal(r.status, 409);
		assert.equal((r.body as { error: string }).error, "syncthing_folder");
	});
});

/** The newest signup code mailed to `email`, from the deployed vault's Mailpit API. */
async function remoteSignupCode(email: string): Promise<string> {
	const headers = { authorization: `Basic ${Buffer.from(MAIL_AUTH as string).toString("base64")}` };
	for (let i = 0; i < 60; i++) {
		const list = (await (await fetch(`${MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { headers })).json()) as { messages?: { ID: string }[] };
		const id = list.messages?.[0]?.ID;
		if (id) {
			const m = (await (await fetch(`${MAIL_URL}/api/v1/message/${id}`, { headers })).json()) as { Text?: string };
			const code = /\n\s+([0-9A-Z]{8})\s*\n/.exec(m.Text ?? "")?.[1];
			if (code) return code.toLowerCase();
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`no signup code mailed to ${email}`);
}

/** A child process running tests/vault-sync-device.ts over a data folder of its own. */
class Device {
	private readonly proc: ChildProcess;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private seq = 0;

	constructor(readonly dataDir: string, vaultUrl: string) {
		this.proc = spawn(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "tests", "vault-sync-device.ts")], {
			cwd: ROOT,
			env: { ...process.env, NODE_ENV: "test", LH_DATA_DIR: dataDir, LH_LOCAL_DIR: `${dataDir}-local`, LH_VAULT_URL: vaultUrl, LH_VAULT_PASSWORD_CHECK: "offline" },
			stdio: ["pipe", "pipe", process.env.LHV_E2E_LOG ? "inherit" : "ignore"],
		});
		this.proc.on("exit", (code) => this.failAll(`the device process exited (${code})`));
		readline.createInterface({ input: this.proc.stdout as NodeJS.ReadableStream }).on("line", (line) => {
			const m = JSON.parse(line) as { rid: number; ok: boolean; result?: unknown; error?: string };
			const p = this.pending.get(m.rid);
			this.pending.delete(m.rid);
			if (m.ok) p?.resolve(m.result);
			else p?.reject(new Error(m.error));
		});
	}

	private failAll(reason: string): void {
		for (const p of this.pending.values()) p.reject(new Error(reason));
		this.pending.clear();
	}

	call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
		const id = ++this.seq;
		if (process.env.LHV_E2E_LOG) console.error(`[${this.dataDir.split("/").pop()}] ${op} ${JSON.stringify(args).slice(0, 120)}`);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			(this.proc.stdin as NodeJS.WritableStream).write(`${JSON.stringify({ rid: id, op, ...args })}\n`);
		});
	}

	route(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
		return this.call("route", { method, path, body }) as Promise<{ status: number; body: unknown }>;
	}

	/** Files in the pre-vault-<date> folders of the local folder (where "Use the vault" moves local files). */
	listMoved(): string[] {
		const local = `${this.dataDir}-local`;
		if (!existsSync(local)) return [];
		const out: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(dir, e.name));
				else out.push(join(dir, e.name));
			}
		};
		for (const e of readdirSync(local, { withFileTypes: true })) if (e.isDirectory() && e.name.startsWith("pre-vault-")) walk(join(local, e.name));
		return out;
	}

	markSyncthing(): void {
		execFileSync("mkdir", ["-p", join(this.dataDir, ".stfolder")]);
	}

	close(): void {
		this.proc.kill("SIGTERM");
	}
}
