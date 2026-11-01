/**
 * Migration into a real vault server, end to end (docs/vault-migration.md): data folders from
 * released builds (tests/fixtures/migration/) sign up, join and merge through the app's own routes.
 * Needs the private vault repo and Postgres, like tests/vault-sync-e2e.test.ts:
 *
 *   LHV_REPO=/path/to/learnharness-vault
 *   LHV_TEST_DATABASE_URL=postgres://lhv:lhv@localhost:55432/postgres?sslmode=disable
 *   GOTOOLCHAIN=go1.26.0                           (optional; that is the default here)
 *
 * Skipped when either variable is missing or the vault client package is not installed.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { after, before, describe, test } from "node:test";

import type { MergeReport, MigrationStateDto } from "../src/core/vault/migration.ts";
import { FIXTURES, digest, files } from "./helpers/migration-fixtures.ts";
import { hasVaultClient } from "./vault-helpers.ts";

const DB_URL = process.env.LHV_TEST_DATABASE_URL;
const REPO = process.env.LHV_REPO;
const skip = !hasVaultClient ? "the vault client package is not installed" : !DB_URL ? "LHV_TEST_DATABASE_URL is not set" : !REPO ? "LHV_REPO is not set" : false;
const ROOT = join(import.meta.dirname, "..");
const PASSWORD = "correct horse battery staple, but longer";

type PgClient = { connect(): Promise<void>; query<T = unknown>(q: string, a?: unknown[]): Promise<{ rows: T[] }>; end(): Promise<void> };
type PgModule = { default: { Client: new (o: { connectionString: string }) => PgClient } } | { Client: new (o: { connectionString: string }) => PgClient };

describe("migration into a real vault: old data folders sign up, join and merge", { skip }, () => {
	let tmp: string;
	let server: ChildProcess;
	let admin: PgClient;
	let db: PgClient;
	let dbName: string;
	let serverUrl: string;
	const children: Device[] = [];

	before(async () => {
		tmp = mkdtempSync(join(tmpdir(), "lh-vault-mig-"));
		const pgModule = createRequire(join(REPO as string, "client", "package.json"))("pg") as PgModule;
		const Client = "Client" in pgModule ? pgModule.Client : pgModule.default.Client;
		const bin = join(tmp, "lhv-server");
		execFileSync("go", ["build", "-o", bin, "./server/cmd/lhv-server"], { cwd: REPO as string, env: { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "go1.26.0" }, stdio: "inherit" });
		dbName = `lh_vault_mig_${process.pid}_${Date.now()}`;
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
		const r = await db.query<{ body_text: string }>("SELECT body_text FROM mail_queue WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [email]);
		const m = /\n\s+([0-9A-Z]{8})\n/.exec(r.rows[0]?.body_text ?? "");
		if (!m) throw new Error(`no signup code mailed to ${email}`);
		return (m[1] as string).toLowerCase();
	}

	/** A device whose folders start as a copy of a fixture. */
	function device(name: string, fixture: string): Device {
		const dataDir = join(tmp, name);
		cpSync(join(FIXTURES, fixture, "lh-data"), dataDir, { recursive: true });
		if (existsSync(join(FIXTURES, fixture, "lh-local"))) cpSync(join(FIXTURES, fixture, "lh-local"), `${dataDir}-local`, { recursive: true });
		const d = new Device(dataDir, serverUrl);
		children.push(d);
		return d;
	}

	async function signUp(d: Device, email: string): Promise<void> {
		assert.equal((await d.route("POST", "/signup/start", { email })).status, 200);
		assert.equal((await d.route("POST", "/signup/verify", { email, code: await signupCode(email) })).status, 200);
		const finish = await d.route("POST", "/signup/finish", { password: PASSWORD });
		assert.equal(finish.status, 200, JSON.stringify(finish.body));
		assert.equal(((await d.route("GET", "/session")).body as { state: string }).state, "signed_in");
		assert.equal((await d.route("POST", "/sync/now")).status, 200);
	}

	const titles = async (d: Device) => ((await d.call("chats")) as { id: string; title: string }[]).map((c) => c.title).sort();
	const chatFiles = (d: Device) => digest(join(d.dataDir, "chats"));

	test("upstream 0.4.1 data: upgraded and backed up on the first sign-up, then every record reaches a second device", async () => {
		const a = device("upstream", "v0.4.1");
		const before = digest(a.dataDir);
		await signUp(a, "mig-upstream@example.org");

		// the folder is in the current format, with a backup beside it in the local folder
		assert.equal(JSON.parse(readFileSync(join(a.dataDir, "graph", "format.json"), "utf8")).version, 2);
		assert.ok(!existsSync(join(a.dataDir, "settings.json")) && !existsSync(join(a.dataDir, "graph", "positions.json")));
		const backups = readdirSync(join(a.local, "backups"));
		assert.equal(backups.length, 1);
		for (const f of files(join(a.dataDir, "chats"))) assert.equal(digest(join(a.local, "backups", backups[0] as string, "data"))[`chats/${f}`], before[`chats/${f}`]);

		// a second, empty device receives all of it
		const b = device("upstream-second", "v0.4.1");
		rmSync(b.dataDir, { recursive: true });
		rmSync(b.local, { recursive: true });
		mkdirSync(b.dataDir);
		assert.equal((await b.route("POST", "/sign-in/password", { email: "mig-upstream@example.org", password: PASSWORD })).status, 200);
		assert.equal((await b.route("POST", "/sync/now")).status, 200);
		assert.deepEqual(await titles(b), ["Photosynthesis", "Relational model"]);
		assert.deepEqual(chatFiles(b), chatFiles(a), "sessions are byte-identical");
		for (const ledger of ["nodes", "chains", "sessions", "coverage"]) assert.equal(digest(join(b.dataDir, "graph"))[`${ledger}.jsonl`], digest(join(a.dataDir, "graph"))[`${ledger}.jsonl`], `the old shared ${ledger} ledger arrived`);
		assert.ok(existsSync(join(b.dataDir, "graph", "sources.json")) && existsSync(join(b.dataDir, "prompts", "switches.json")));
		assert.ok(!existsSync(join(b.dataDir, "settings.json")), "device-local files never sync");
		// the job that was running when 0.4.1 stopped belongs to the device that migrated it
		const jobs = files(join(b.dataDir, "jobs")).map((f) => JSON.parse(readFileSync(join(b.dataDir, "jobs", f), "utf8")) as { status: string; deviceId?: string });
		assert.equal(jobs.find((j) => j.status === "running")?.deviceId, a.deviceId());
	});

	test("a Syncthing folder with conflict copies: refused, guided, then migrated; the conflict copy stays where the picker reads it", async () => {
		const a = device("syncthing", "v0.3.8001");
		mkdirSync(join(a.dataDir, ".stfolder"));
		mkdirSync(join(a.dataDir, ".stversions"));
		writeFileSync(join(a.dataDir, ".stversions", "keep.txt"), "Syncthing's own old version");
		const chat = files(join(a.dataDir, "chats"))[0] as string;
		const id = chat.replace(/\.json$/, "");
		const copy = `${id}.sync-conflict-20261001-101010-ABCDEFG.json`;
		const record = JSON.parse(readFileSync(join(a.dataDir, "chats", chat), "utf8")) as { messages: unknown[] };
		writeFileSync(join(a.dataDir, "chats", copy), JSON.stringify({ ...record, messages: [...record.messages, { role: "user", content: "from the other device", timestamp: 9 }] }));
		writeFileSync(join(a.dataDir, "prompts", "system-prompt.sync-conflict-20261001-101010-ABCDEFG.md"), "# other");

		const email = "mig-syncthing@example.org";
		const refused = await a.route("POST", "/signup/start", { email });
		assert.equal(refused.status, 409);
		assert.equal((refused.body as { error: string }).error, "syncthing_folder");
		const state = (await a.route("GET", "/migration/report")).body as MigrationStateDto;
		assert.equal(state.syncthing.needed, true);
		assert.ok(state.syncthing.steps.length >= 3);
		assert.equal(state.report.counts.conflicts, 2);
		assert.equal((await a.route("POST", "/migration/syncthing/set-aside", {})).status, 400, "needs the learner's confirmation");
		const moved = (await a.route("POST", "/migration/syncthing/set-aside", { confirmed: true })).body as { moved: string[]; remaining: string[] };
		assert.deepEqual([moved.moved.sort(), moved.remaining], [[".stfolder", ".stversions"], []]);

		await signUp(a, email);
		assert.ok(existsSync(join(a.dataDir, "chats", copy)), "the session conflict copy is still beside its session");
		assert.ok(existsSync(join(a.local, "conflicts", "prompts", "system-prompt.sync-conflict-20261001-101010-ABCDEFG.md")), "the other conflict copy is kept in the conflicts folder");
		const stversions = files(a.local).filter((f) => f.endsWith("keep.txt"));
		assert.equal(stversions.length, 1, "Syncthing's versions were moved, not deleted");
		// conflict copies are device-local: the vault holds the session, not the copy
		const b = device("syncthing-second", "v0.4.1");
		rmSync(b.dataDir, { recursive: true });
		mkdirSync(b.dataDir);
		assert.equal((await b.route("POST", "/sign-in/password", { email, password: PASSWORD })).status, 200);
		assert.equal((await b.route("POST", "/sync/now")).status, 200);
		assert.ok(existsSync(join(b.dataDir, "chats", chat)));
		assert.ok(!existsSync(join(b.dataDir, "chats", copy)));
	});

	test("two devices with diverged copies: merge adds what is missing, keeps both versions of a diverged session, duplicates nothing", async () => {
		const a = device("desktop", "v0.4.2001");
		const email = "mig-merge@example.org";
		await signUp(a, email);
		const aChats = files(join(a.dataDir, "chats"));
		const [first, second] = aChats as [string, string];

		// the second device kept using an upstream build: it has its own sessions, a copy of A's first session that it continued,
		// and a copy of A's second session that both devices continued
		const b = device("laptop", "v0.4.1");
		const bOwn = files(join(b.dataDir, "chats"));
		const readChat = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, "chats", f), "utf8")) as { messages: unknown[] };
		const msg = (text: string) => ({ role: "user", content: text, timestamp: 77 });
		writeFileSync(join(b.dataDir, "chats", first), JSON.stringify({ ...readChat(a.dataDir, first), messages: [...readChat(a.dataDir, first).messages, msg("laptop continued")] }, null, "\t"));
		writeFileSync(join(b.dataDir, "chats", second), JSON.stringify({ ...readChat(a.dataDir, second), messages: [...readChat(a.dataDir, second).messages, msg("laptop answer")] }, null, "\t"));
		await a.call("saveMessages", { id: second.replace(/\.json$/, ""), messages: [...readChat(a.dataDir, second).messages, msg("desktop answer")] });
		assert.equal((await a.route("POST", "/sync/now")).status, 200);

		const joining = (await b.route("POST", "/sign-in/password", { email, password: PASSWORD })).body as { state: string; localFiles: number };
		assert.equal(joining.state, "joining");
		assert.ok(joining.localFiles > 0);
		assert.equal((await b.route("POST", "/session/join", { choice: "merge" })).status, 200);
		assert.equal((await b.route("POST", "/sync/now")).status, 200);

		// on the laptop: its own sessions are back, A's first session is the laptop's longer copy, the diverged one has a conflict copy
		const onB = await titles(b);
		assert.equal(onB.length, bOwn.length + aChats.length, "the laptop's two sessions plus the desktop's two, none twice");
		assert.equal(readChat(b.dataDir, first).messages.at(-1) && (readChat(b.dataDir, first).messages.at(-1) as { content: string }).content, "laptop continued");
		assert.equal((readChat(b.dataDir, second).messages.at(-1) as { content: string }).content, "desktop answer", "the vault's version stays the session");
		const conflict = files(join(b.dataDir, "chats")).find((f) => f.startsWith(`${second.replace(/\.json$/, "")}.sync-conflict-`)) as string;
		assert.ok(conflict, "the laptop's version is kept as a conflict copy");
		assert.equal((readChat(b.dataDir, conflict).messages.at(-1) as { content: string }).content, "laptop answer");
		const mergeFile = readdirSync(join(b.local, "migration")).find((f) => f.startsWith("merge-pre-vault-")) as string;
		const report = JSON.parse(readFileSync(join(b.local, "migration", mergeFile), "utf8")) as MergeReport;
		assert.deepEqual([report.sessions.continued, report.sessions.conflictCopies], [1, 1]);
		assert.ok(report.sessions.added >= 2, "the laptop's own sessions");
		assert.ok(report.graphLines.added > 0);
		// the laptop's own graph file holds what the vault lacked; nothing it did not write was touched
		assert.ok(files(join(b.dataDir, "graph")).some((f) => f.startsWith("nodes.dev_") && JSON.parse(readFileSync(join(b.dataDir, "graph", f), "utf8").trim().split("\n")[0] as string).id));

		// it all reaches the desktop, once
		assert.equal((await b.route("POST", "/sync/now")).status, 200);
		assert.equal((await a.route("POST", "/sync/now")).status, 200);
		assert.deepEqual(await titles(a), onB);
		assert.equal((readChat(a.dataDir, first).messages.at(-1) as { content: string }).content, "laptop continued");
		assert.ok(!files(join(a.dataDir, "chats")).some((f) => f.includes(".sync-conflict-")), "conflict copies stay on the device that made them");
		// merging the same folder again changes nothing
		const before = digest(b.dataDir);
		const name = readdirSync(b.local).find((f) => f.startsWith("pre-vault-")) as string;
		const again = (await b.route("POST", "/migration/merge", { name })).body as MergeReport;
		assert.deepEqual([again.sessions.added, again.sessions.continued, again.sessions.conflictCopies, again.graphLines.added, again.jobs.added], [0, 0, 0, 0, 0]);
		assert.deepEqual(digest(b.dataDir), before);
	});

	test("\"Use the vault\" moves the files aside, and a later merge from Settings brings the missing sessions back", async () => {
		const a = device("owner-desktop", "v0.4.2001");
		const email = "mig-restore@example.org";
		await signUp(a, email);
		const c = device("old-phone", "v0.3.0");
		const own = files(join(c.dataDir, "chats"));
		assert.equal(((await c.route("POST", "/sign-in/password", { email, password: PASSWORD })).body as { state: string }).state, "joining");
		assert.equal((await c.route("POST", "/session/join", { choice: "use-vault" })).status, 200);
		assert.equal((await c.route("POST", "/sync/now")).status, 200);
		assert.ok(own.every((f) => !existsSync(join(c.dataDir, "chats", f))), "moved aside");
		const state = (await c.route("GET", "/migration/report")).body as MigrationStateDto;
		assert.equal(state.movedAside.length, 1);
		assert.equal(state.movedAside[0]?.merged, false);
		assert.equal((await c.route("POST", "/migration/merge", { name: "pre-vault-../x" })).status, 500, "only the app's own folders");
		const merged = await c.route("POST", "/migration/merge", { name: state.movedAside[0]?.name });
		assert.equal(merged.status, 200, JSON.stringify(merged.body));
		assert.ok(own.every((f) => existsSync(join(c.dataDir, "chats", f))), "restored");
		assert.equal((await c.route("POST", "/sync/now")).status, 200);
		assert.equal((await a.route("POST", "/sync/now")).status, 200);
		assert.ok(own.every((f) => existsSync(join(a.dataDir, "chats", f))), "and uploaded to the other device");
		assert.equal(((await c.route("GET", "/migration/report")).body as MigrationStateDto).movedAside[0]?.merged, true);
	});

	test("data of a newer build stops the first sign-in and changes nothing", async () => {
		const a = device("newer", "v0.4.2001");
		writeFileSync(join(a.dataDir, "graph", "format.json"), JSON.stringify({ version: 3 }));
		const before = digest(a.dataDir);
		const email = "mig-newer@example.org";
		await a.route("POST", "/signup/start", { email });
		await a.route("POST", "/signup/verify", { email, code: await signupCode(email) });
		const r = await a.route("POST", "/signup/finish", { password: PASSWORD });
		assert.equal((r.body as { error?: string }).error, "data_newer");
		assert.deepEqual(digest(a.dataDir), before);
	});
});

/** A child process running tests/vault-sync-device.ts over a data folder of its own. */
class Device {
	private readonly proc: ChildProcess;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private seq = 0;
	readonly local: string;

	constructor(readonly dataDir: string, vaultUrl: string) {
		this.local = `${dataDir}-local`;
		mkdirSync(this.local, { recursive: true });
		this.proc = spawn(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "tests", "vault-sync-device.ts")], {
			cwd: ROOT,
			env: { ...process.env, NODE_ENV: "test", LH_DATA_DIR: dataDir, LH_LOCAL_DIR: this.local, LH_VAULT_URL: vaultUrl, LH_VAULT_PASSWORD_CHECK: "offline" },
			stdio: ["pipe", "pipe", process.env.LHV_E2E_LOG ? "inherit" : "ignore"],
		});
		this.proc.on("exit", (code) => this.failAll(`the device process exited (${code})`));
		readline.createInterface({ input: this.proc.stdout as NodeJS.ReadableStream }).on("line", (line) => {
			let m: { rid: number; ok: boolean; result?: unknown; error?: string };
			try {
				m = JSON.parse(line) as typeof m;
			} catch {
				return; // a log line of the app on stdout
			}
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
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			(this.proc.stdin as NodeJS.WritableStream).write(`${JSON.stringify({ rid: id, op, ...args })}\n`);
		});
	}

	route(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
		return this.call("route", { method, path, body }) as Promise<{ status: number; body: unknown }>;
	}

	/** This device's id, read from its device-local folder. */
	deviceId(): string {
		return (JSON.parse(readFileSync(join(this.local, "device.json"), "utf8")) as { id: string }).id;
	}

	close(): void {
		this.proc.kill("SIGTERM");
	}
}
