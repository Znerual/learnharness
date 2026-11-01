/**
 * The data folder upgrade (src/server/migration/upgrade.ts) on a fixture folder per supported source
 * (tests/fixtures/migration/, written with each release's own store code): dry run, backup, every
 * step, idempotence, a crash after every step, Syncthing leftovers and conflict copies, data from a
 * newer build. No vault is involved here; migration-vault.test.ts runs the whole way into a vault server.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

import { MigrationRefusedError, readJournal, scanDataFolder, upgradeDataFolder, type StepId } from "../src/server/migration/upgrade.ts";
import { planSwitch, setAsideMarkers } from "../src/server/migration/syncthing.ts";
import { assertNotSyncthing } from "../src/server/vault/syncthing.ts";
import { copyFixture, DEVICE, digest, files, json, read, SOURCES } from "./helpers/migration-fixtures.ts";

const opts = { device: DEVICE, now: () => new Date("2026-11-01T12:00:00Z") };
/** The records a migration must carry over byte for byte. */
const synced = (f: string) => !/^graph\/(edges|events|mappings)\.jsonl$/.test(f) && (/^(chats|jobs)\/[^/]+\.json$/.test(f) || /^graph\/[a-z]+(\.dev_[a-z0-9]{8})?\.jsonl$/.test(f) || f === "graph/sources.json" || f === "prompts/system-prompt.md");

for (const src of SOURCES) {
	describe(`${src.name} (${src.who})`, () => {
		test("the dry run reads only and says what would change", () => {
			const f = copyFixture(src.name);
			const before = digest(f.root);
			const report = scanDataFolder(f);
			assert.deepEqual(digest(f.root), before, "a scan writes nothing");
			assert.equal(report.layout, src.older ? "older" : "current");
			assert.equal(report.counts.sessions, 2);
			assert.equal(report.counts.jobs, 2);
			assert.equal(report.blocked, null);
			assert.equal(report.needed, src.needed, src.needed ? "something is pending" : "already in the current format");
			assert.equal(report.steps.length > 0, src.needed);
			if (src.older) {
				const ids = report.steps.map((s) => s.id);
				for (const id of ["backup", "local-split", "prompt-switches", "graph-format", "job-owner"] as StepId[]) assert.ok(ids.includes(id), `${id} planned`);
				assert.equal(report.graphFormat, 1);
			}
			assert.equal(report.steps.some((s) => s.id === "stray-files"), src.deadFiles);
		});

		test("upgrade backs up first, brings the folder to the current format and loses nothing", () => {
			const f = copyFixture(src.name);
			const original = digest(f.dataDir);
			const result = upgradeDataFolder(f, opts);
			if (!src.needed) {
				assert.equal(result.backupDir, null, "nothing to change, so no backup either");
				assert.deepEqual(digest(f.dataDir), original);
				return;
			}
			assert.ok(result.backupDir);
			// the backup is a byte-for-byte copy of every file but the disposable debug recordings
			const backup = digest(path.join(result.backupDir as string, "data"));
			for (const [file, hash] of Object.entries(original)) if (!file.startsWith("debug/")) assert.equal(backup[file], hash, `backup of ${file}`);
			assert.ok(!path.resolve(result.backupDir as string).startsWith(path.resolve(f.dataDir)), "never inside the synced folder");

			// current format
			assert.equal(json(f.dataDir, "graph", "format.json").version, 2);
			for (const legacy of ["settings.json", "graph/positions.json", "graph/render-settings.json", "debug"]) assert.ok(!fs.existsSync(path.join(f.dataDir, legacy)), `${legacy} left the data folder`);
			assert.deepEqual(json(f.dataDir, "prompts", "switches.json"), { "system-prompt.md": true });
			if (src.older) assert.ok(fs.existsSync(path.join(f.localDir, "settings.json")) && fs.existsSync(path.join(f.localDir, "positions.json")));
			assert.equal(json(f.localDir, "settings.json").agent?.prompts, undefined, "switches left the settings record");
			const running = files(path.join(f.dataDir, "jobs")).map((j) => json(f.dataDir, "jobs", j)).find((j) => j.status === "running");
			assert.deepEqual([running.deviceId, running.deviceName], [DEVICE.id, DEVICE.name]);

			// nothing synced was lost or altered, except the one job that gained an owner
			const after = digest(f.dataDir);
			for (const [file, hash] of Object.entries(original)) {
				if (!synced(file) || file.startsWith("jobs/")) continue;
				assert.equal(after[file], hash, `${file} is unchanged`);
			}
			for (const dead of ["edges", "events", "mappings"]) assert.ok(!fs.existsSync(path.join(f.dataDir, "graph", `${dead}.jsonl`)));
			if (src.deadFiles) assert.ok(files(path.join(f.localDir, "migration", "set-aside")).some((x) => x.endsWith("graph/mappings.jsonl")), "set aside, not deleted");
		});

		test("running it again changes nothing and takes no second backup", () => {
			const f = copyFixture(src.name);
			upgradeDataFolder(f, opts);
			const settled = digest(f.root);
			const again = upgradeDataFolder(f, { ...opts, now: () => new Date("2026-11-02T12:00:00Z") });
			assert.deepEqual(again.ran, []);
			assert.equal(again.backupDir, null);
			assert.deepEqual(digest(f.root), settled);
			assert.equal(scanDataFolder(f).needed, false);
		});

		test("a crash after any step is finished by the next run, with the first backup", { skip: !src.needed && "nothing to do" }, () => {
			const clean = copyFixture(src.name);
			upgradeDataFolder(clean, opts);
			const want = digest(clean.dataDir);
			const wantLocal = digest(clean.localDir);
			const stepIds = ["local-split", "prompt-switches", "stray-files", "conflicts", "graph-format", "job-owner"] as StepId[];
			for (const crashAt of [...stepIds, "backup-copy"]) {
				const f = copyFixture(src.name);
				const original = digest(f.dataDir);
				const crash = () => {
					throw new Error("power loss");
				};
				assert.throws(() => upgradeDataFolder(f, crashAt === "backup-copy" ? { ...opts, afterBackupCopy: crash } : { ...opts, afterStep: (id) => id === crashAt && crash() }), /power loss/);
				const journal = readJournal(f);
				assert.ok(journal && !journal.finishedAt, "an unfinished run is journaled");
				const resumed = upgradeDataFolder(f, { ...opts, now: () => new Date("2026-11-03T08:00:00Z") });
				assert.equal(resumed.backupDir, journal?.backupDir, "the same backup");
				const backup = digest(path.join(journal?.backupDir as string, "data"));
				for (const [file, hash] of Object.entries(original)) if (!file.startsWith("debug/")) assert.equal(backup[file], hash, `backup of ${file} after a crash at ${crashAt}`);
				assert.deepEqual(digest(f.dataDir), want, `data after a crash at ${crashAt}`);
				// the running job's owner and the other device-local files match an uninterrupted run
				const local = digest(f.localDir);
				for (const k of ["settings.json", "positions.json"]) assert.equal(local[k], wantLocal[k], `${k} after a crash at ${crashAt}`);
				assert.ok(readJournal(f)?.finishedAt);
				assert.deepEqual(upgradeDataFolder(f, opts).ran, []);
			}
		});
	});
}

describe("Syncthing folder and conflict copies", () => {
	function shared() {
		const f = copyFixture("v0.4.1");
		const data = f.dataDir;
		const sessions = files(path.join(data, "chats"));
		const id = sessions[0]?.replace(/\.json$/, "") as string;
		const record = json(data, "chats", `${id}.json`);
		fs.mkdirSync(path.join(data, ".stfolder"));
		fs.mkdirSync(path.join(data, ".stversions", "chats"), { recursive: true });
		fs.writeFileSync(path.join(data, ".stversions", "chats", `${id}~20261001-090000.json`), "old version");
		fs.writeFileSync(path.join(data, ".stignore"), "(?d).DS_Store\n");
		// another device kept its version of the session: same start, one more message
		const other = { ...record, messages: [...record.messages, { role: "user", content: "from the phone", timestamp: 1 }] };
		const conflictName = `${id}.sync-conflict-20261001-101010-ABCDEFG.json`;
		fs.writeFileSync(path.join(data, "chats", conflictName), JSON.stringify(other, null, "\t"));
		// a conflict copy whose session file is gone
		fs.writeFileSync(path.join(data, "chats", "chat_lost_1.sync-conflict-20261001-101010-ABCDEFG.json"), JSON.stringify({ ...record, id: "chat_lost_1" }, null, "\t"));
		// the shared ledger and another file with a conflict copy
		const nodes = read(data, "graph", "nodes.jsonl");
		const extra = JSON.stringify({ id: "n_phone00001", name: "Only on the phone", statement: "x", aliases: [], createdAt: "2026-10-21T10:00:00.000Z", provenance: [] });
		fs.writeFileSync(path.join(data, "graph", "nodes.sync-conflict-20261001-101010-ABCDEFG.jsonl"), `${nodes}${extra}\n`);
		fs.writeFileSync(path.join(data, "prompts", "system-prompt.sync-conflict-20261001-101010-ABCDEFG.md"), "# phone version\n");
		fs.writeFileSync(path.join(data, "graph", ".syncthing.sources.json.tmp"), "{");
		return { ...f, id, conflictName, extra };
	}

	test("the vault refuses the folder until Syncthing's markers are out of the way", () => {
		const s = shared();
		assert.throws(() => assertNotSyncthing(s.dataDir), { code: "syncthing_folder" });
		const plan = planSwitch(s.dataDir);
		assert.equal(plan.needed, true);
		assert.ok(plan.steps.length >= 3);
		assert.deepEqual(plan.markers.map((m) => m.name).sort(), [".stfolder", ".stignore", ".stversions"]);
		assert.ok(plan.markers.every((m) => m.canSetAside));
	});

	test("the upgrade leaves Syncthing's files alone and sorts the conflict copies", () => {
		const s = shared();
		const report = scanDataFolder(s);
		const byPath = Object.fromEntries(report.conflicts.map((c) => [c.path, c.action]));
		assert.equal(byPath[`chats/${s.conflictName}`], "keep");
		assert.equal(byPath["chats/chat_lost_1.sync-conflict-20261001-101010-ABCDEFG.json"], "promote");
		assert.equal(byPath["graph/nodes.sync-conflict-20261001-101010-ABCDEFG.jsonl"], "merge-lines");
		assert.equal(byPath["prompts/system-prompt.sync-conflict-20261001-101010-ABCDEFG.md"], "set-aside");
		const stversions = digest(path.join(s.dataDir, ".stversions"));

		upgradeDataFolder(s, opts);
		assert.deepEqual(digest(path.join(s.dataDir, ".stversions")), stversions);
		assert.ok(fs.existsSync(path.join(s.dataDir, ".stfolder")) && fs.existsSync(path.join(s.dataDir, ".stignore")));
		// the session conflict stays under the name the conflict picker reads (conflictPattern in src/store/chats.ts)
		assert.match(s.conflictName, new RegExp(`^${s.id}\\.sync-conflict-[A-Za-z0-9-]+\\.json$`));
		assert.ok(fs.existsSync(path.join(s.dataDir, "chats", s.conflictName)));
		// the orphan copy became a session
		assert.equal(json(s.dataDir, "chats", "chat_lost_1.json").id, "chat_lost_1");
		// the ledger got the line only the copy had; the copy itself is kept in the conflicts folder
		assert.ok(read(s.dataDir, "graph", "nodes.jsonl").includes("n_phone00001"));
		assert.equal(fs.existsSync(path.join(s.dataDir, "graph", "nodes.sync-conflict-20261001-101010-ABCDEFG.jsonl")), false);
		assert.ok(fs.existsSync(path.join(s.localDir, "conflicts", "graph", "nodes.sync-conflict-20261001-101010-ABCDEFG.jsonl")));
		assert.ok(fs.existsSync(path.join(s.localDir, "conflicts", "prompts", "system-prompt.sync-conflict-20261001-101010-ABCDEFG.md")));
		assert.equal(read(s.dataDir, "prompts", "system-prompt.md").includes("phone version"), false);
		// torn Syncthing temp file set aside
		assert.ok(!fs.existsSync(path.join(s.dataDir, "graph", ".syncthing.sources.json.tmp")));
		// a second run does not merge the ledger line twice
		upgradeDataFolder(s, opts);
		assert.equal(read(s.dataDir, "graph", "nodes.jsonl").split("n_phone00001").length - 1, 1);
	});

	test("setting the markers aside deletes nothing and lets the vault start", () => {
		const s = shared();
		upgradeDataFolder(s, opts);
		const before = digest(path.join(s.dataDir, ".stversions"));
		const r = setAsideMarkers({ dataDir: s.dataDir, localDir: s.localDir, now: opts.now });
		assert.deepEqual(r.moved.map((m) => m.name).sort(), [".stfolder", ".stignore", ".stversions"]);
		assert.deepEqual(r.remaining, []);
		assert.doesNotThrow(() => assertNotSyncthing(s.dataDir));
		const moved = r.moved.find((m) => m.name === ".stversions")?.to as string;
		assert.deepEqual(digest(moved), before, "Syncthing's versions are all still there");
	});

	test("a marker above the data folder is reported, not touched", () => {
		const f = copyFixture("v0.4.1");
		const parent = path.join(f.root, "shared");
		fs.mkdirSync(path.join(parent, ".stfolder"), { recursive: true });
		const data = path.join(parent, "data");
		fs.cpSync(f.dataDir, data, { recursive: true });
		const plan = planSwitch(data);
		assert.equal(plan.needed, true);
		assert.equal(plan.markers[0]?.canSetAside, false);
		const r = setAsideMarkers({ dataDir: data, localDir: f.localDir, now: opts.now });
		assert.deepEqual(r.moved, []);
		assert.equal(r.remaining.length, 1);
		assert.ok(fs.existsSync(path.join(parent, ".stfolder")));
	});
});

describe("refusals and odd files", () => {
	test("data saved by a newer build is never changed", () => {
		const f = copyFixture("v0.4.2001");
		fs.writeFileSync(path.join(f.dataDir, "graph", "format.json"), JSON.stringify({ version: 3 }));
		const chat = files(path.join(f.dataDir, "chats"))[0] as string;
		fs.writeFileSync(path.join(f.dataDir, "chats", chat), JSON.stringify({ ...json(f.dataDir, "chats", chat), version: 2 }));
		const before = digest(f.root);
		assert.equal(scanDataFolder(f).blocked?.reason, "data_newer");
		assert.throws(() => upgradeDataFolder(f, opts), MigrationRefusedError);
		assert.deepEqual(digest(f.root), before);
	});

	test("an unreadable session or job moves aside and is named in the report", () => {
		const f = copyFixture("v0.4.1");
		fs.writeFileSync(path.join(f.dataDir, "chats", "chat_torn_1.json"), '{"id":"chat_torn_1","messages":[');
		assert.deepEqual(scanDataFolder(f).unreadable, ["chats/chat_torn_1.json"]);
		upgradeDataFolder(f, opts);
		assert.ok(!fs.existsSync(path.join(f.dataDir, "chats", "chat_torn_1.json")));
		assert.ok(files(path.join(f.localDir, "migration", "set-aside")).some((x) => x.endsWith("chats/chat_torn_1.json")));
	});

	test("a stale legacy settings file next to the device-local one is set aside, the local one wins", () => {
		const f = copyFixture("v0.4.2001");
		fs.writeFileSync(path.join(f.dataDir, "settings.json"), JSON.stringify({ version: 1, general: { stale: true } }));
		const local = read(f.localDir, "settings.json");
		upgradeDataFolder(f, opts);
		assert.equal(read(f.localDir, "settings.json"), local);
		assert.ok(!fs.existsSync(path.join(f.dataDir, "settings.json")));
	});

	test("an empty folder needs nothing and is not touched", () => {
		const f = copyFixture("v0.4.1");
		fs.rmSync(f.dataDir, { recursive: true });
		fs.mkdirSync(f.dataDir);
		const r = upgradeDataFolder(f, opts);
		assert.equal(r.report.layout, "empty");
		assert.deepEqual(r.ran, []);
		assert.equal(readJournal(f), null);
	});

	test("the local folder inside the data folder is refused (a backup there would sync)", () => {
		const f = copyFixture("v0.4.1");
		assert.throws(() => upgradeDataFolder({ dataDir: f.dataDir, localDir: path.join(f.dataDir, "local") }, opts), /outside the data folder/);
	});
});
