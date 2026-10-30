/**
 * The fork's update feed (2026-10-24). An upstream release once replaced
 * a fork build through the auto-updater and dropped the fork's features.
 * Pinned: installed apps update only from the fork's own GitHub releases,
 * and fork versions carry the fork counter (upstream patch * 1000 + n),
 * so they rank above the upstream release they are based on.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("the fork update feed", () => {
	it("publishes and updates from Znerual/learnharness only", () => {
		const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
		const publish = yml.slice(yml.indexOf("\npublish:"));
		assert.match(publish, /provider: github\n\s+owner: Znerual\n\s+repo: learnharness\n/);
		assert.doesNotMatch(publish, /owner: amosblomqvist/);
	});
	it("versions as upstream + fork counter", () => {
		const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
		assert.ok(match, `plain semver, no prerelease: ${version}`);
		assert.ok(Number(match[3]) >= 1000, `the patch carries the fork counter (e.g. 0.4.1001): ${version}`);
	});
});
