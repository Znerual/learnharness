/**
 * Handover to the successor install (electron/identity-handover.cjs): a build
 * under the old shared identity starts "LearnHarness Vault" when that is
 * installed, instead of booting itself.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
type Candidate = { file: string; command: string; args: string[] };
type Where = { platform: string; env: Record<string, string | undefined>; home: string; execPath: string; exists(file: string): boolean };
const { findSuccessor, startSuccessor, successorCandidates } = require("../electron/identity-handover.cjs") as {
	successorCandidates(w: Pick<Where, "platform" | "env" | "home">): Candidate[];
	findSuccessor(w: Where): Candidate | null;
	startSuccessor(c: Candidate, o: { spawn: (...a: unknown[]) => unknown; env: Record<string, string | undefined> }): boolean;
};

const WIN_EXE = "C:\\Users\\a\\AppData\\Local\\Programs\\learnharness-vault\\LearnHarness Vault.exe";
const DEB_EXE = "/opt/LearnHarness Vault/learnharness-vault";
const win = { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a", execPath: "C:\\Users\\a\\AppData\\Local\\Programs\\learnharness\\LearnHarness.exe" };
const linux = { platform: "linux", env: {}, home: "/home/a", execPath: "/opt/LearnHarness/learnharness" };
const mac = { platform: "darwin", env: {}, home: "/Users/a", execPath: "/Applications/LearnHarness.app/Contents/MacOS/LearnHarness" };

describe("handover to the successor install", () => {
	it("knows the successor's install path on each system", () => {
		assert.deepEqual(successorCandidates(win).map((c) => c.file), [WIN_EXE]);
		assert.deepEqual(successorCandidates(linux).map((c) => c.file), [DEB_EXE]);
		assert.deepEqual(successorCandidates(mac).map((c) => c.file), ["/Applications/LearnHarness Vault.app", "/Users/a/Applications/LearnHarness Vault.app"]);
		assert.deepEqual(successorCandidates({ platform: "win32", env: {}, home: "" }), []);
		assert.deepEqual(successorCandidates({ platform: "freebsd", env: {}, home: "/home/a" }), []);
	});
	it("finds an installed successor, and nothing when it is not installed", () => {
		assert.equal(findSuccessor({ ...win, exists: () => false }), null);
		assert.equal(findSuccessor({ ...win, exists: (f) => f === WIN_EXE })?.command, WIN_EXE);
		assert.equal(findSuccessor({ ...linux, exists: (f) => f === DEB_EXE })?.command, DEB_EXE);
		const bundle = "/Users/a/Applications/LearnHarness Vault.app";
		assert.deepEqual(findSuccessor({ ...mac, exists: (f) => f === bundle }), { file: bundle, command: "/usr/bin/open", args: ["-n", bundle] });
	});
	it("never hands over to itself, when turned off, or when the check throws", () => {
		assert.equal(findSuccessor({ ...linux, execPath: DEB_EXE, exists: () => true }), null);
		assert.equal(findSuccessor({ ...win, execPath: WIN_EXE, exists: () => true }), null);
		assert.equal(findSuccessor({ ...mac, execPath: "/Applications/LearnHarness Vault.app/Contents/MacOS/LearnHarness Vault", exists: () => true }), null);
		assert.equal(findSuccessor({ ...linux, env: { LH_NO_HANDOVER: "1" }, exists: () => true }), null);
		assert.equal(findSuccessor({ ...linux, exists: () => { throw new Error("EACCES"); } }), null);
	});
	it("starts the successor detached and reports a failed start", () => {
		const calls: unknown[][] = [];
		let unref = 0;
		const ok = startSuccessor({ file: DEB_EXE, command: DEB_EXE, args: [] }, {
			env: { HOME: "/home/a", LH_NO_HANDOVER: "0" },
			spawn: (...a: unknown[]) => { calls.push(a); return { on() {}, unref() { unref++; } }; },
		});
		assert.equal(ok, true);
		assert.equal(unref, 1);
		assert.equal(calls[0]![0], DEB_EXE);
		assert.deepEqual(calls[0]![2], { detached: true, stdio: "ignore", env: { HOME: "/home/a" } });
		assert.equal(startSuccessor({ file: DEB_EXE, command: DEB_EXE, args: [] }, { env: {}, spawn: () => { throw new Error("ENOENT"); } }), false);
	});
});
