"use strict";
/**
 * Handover to the successor install (owner, 2026-11-18).
 *
 * The fork leaves the install identity it shares with upstream ("LearnHarness",
 * com.learnharness.LearnHarness) for its own ("LearnHarness Vault",
 * io.github.znerual.learnharness, package learnharness-vault). A build under
 * the new identity installs BESIDE this one. Where the updater restarts the
 * program it was started from (the deb updater: `dpkg -i`, then
 * app.relaunch()), this old build would come up again, find the same update
 * and loop. So this build looks for the successor at every start: when it is
 * installed, it starts the successor and quits. The successor then moves the
 * data and removes this install.
 *
 * The paths below are the successor's install locations. They are fixed here,
 * in a build that ships before the successor exists; the successor's
 * electron-builder.yml must produce exactly these (guarded by a test there).
 *
 * An AppImage needs no handover: its updater replaces the file in place.
 * LH_NO_HANDOVER=1 turns the check off (tests, and running both on purpose).
 */

const path = require("node:path");

const SUCCESSOR_PRODUCT_NAME = "LearnHarness Vault";
const SUCCESSOR_PACKAGE_NAME = "learnharness-vault";

/**
 * Where the successor's installers put its program, most specific first.
 * Each entry: `file` must exist; `command` and `args` start it.
 */
function successorCandidates({ platform, env, home }) {
	if (platform === "win32") {
		const local = env.LOCALAPPDATA;
		if (!local) return [];
		// NSIS, one-click, per user: %LOCALAPPDATA%\Programs\<package name>\<product name>.exe
		const exe = path.win32.join(local, "Programs", SUCCESSOR_PACKAGE_NAME, `${SUCCESSOR_PRODUCT_NAME}.exe`);
		return [{ file: exe, command: exe, args: [] }];
	}
	if (platform === "darwin") {
		const bundles = ["/Applications", ...(home ? [path.posix.join(home, "Applications")] : [])].map((dir) =>
			path.posix.join(dir, `${SUCCESSOR_PRODUCT_NAME}.app`),
		);
		// -n: a new instance even when LaunchServices thinks the bundle is running.
		return bundles.map((bundle) => ({ file: bundle, command: "/usr/bin/open", args: ["-n", bundle] }));
	}
	if (platform === "linux") {
		// deb: /opt/<product name>/<executable name>
		const exe = path.posix.join("/opt", SUCCESSOR_PRODUCT_NAME, SUCCESSOR_PACKAGE_NAME);
		return [{ file: exe, command: exe, args: [] }];
	}
	return [];
}

/**
 * The installed successor, or null. Null too when this program IS the
 * successor (its own path is a candidate) and when the check is turned off.
 */
function findSuccessor({ platform, env, home, execPath, exists }) {
	if (env.LH_NO_HANDOVER === "1") return null;
	for (const candidate of successorCandidates({ platform, env, home })) {
		if (execPath === candidate.file || execPath.startsWith(candidate.file + (platform === "win32" ? "\\" : "/"))) return null;
		let found = false;
		try {
			found = exists(candidate.file);
		} catch {
			found = false;
		}
		if (found) return candidate;
	}
	return null;
}

/**
 * Start the successor, detached, so it outlives this process. True when the
 * start was issued; false leaves the caller to boot normally (a failed
 * handover must never keep the learner out of the app).
 */
function startSuccessor(candidate, { spawn, env }) {
	try {
		// The successor must not inherit this build's overrides of its own settings.
		const childEnv = { ...env };
		delete childEnv.LH_NO_HANDOVER;
		const child = spawn(candidate.command, candidate.args, { detached: true, stdio: "ignore", env: childEnv });
		child.on?.("error", () => {});
		child.unref?.();
		return true;
	} catch {
		return false;
	}
}

module.exports = { SUCCESSOR_PRODUCT_NAME, SUCCESSOR_PACKAGE_NAME, successorCandidates, findSuccessor, startSuccessor };
