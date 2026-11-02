/** What's new in an update: the vault host's changelog beside the generic feed (electron/changelog.cjs). */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { changelogUrlFor, changesBetween, compareVersions, fetchChanges } = require("../electron/changelog.cjs") as {
	changelogUrlFor(feed: unknown): string | null;
	changesBetween(releases: unknown, installed: string, offered: string): { version: string; released: string; notes: string }[];
	compareVersions(a: string, b: string): number;
	fetchChanges(url: string | null, installed: string, offered: string, f?: typeof fetch): Promise<unknown[]>;
};

const releases = [
	{ version: "0.4.2108", released: "2026-11-02", notes: "- eight" },
	{ version: "0.4.2110", released: "2026-11-03", notes: "- ten (not offered yet)" },
	{ version: "0.4.2107", released: "2026-11-02" },
	{ version: "0.4.2106", released: "2026-11-02", notes: "- six" },
	{ version: "nope" },
];

describe("update changelog", () => {
	it("lives beside the feed on the vault host; GitHub feeds have none", () => {
		assert.equal(changelogUrlFor("https://learn-vault.ddns.net/updates/"), "https://learn-vault.ddns.net/download/changelog.json");
		assert.equal(changelogUrlFor("https://learn-vault.ddns.net/updates"), "https://learn-vault.ddns.net/download/changelog.json");
		assert.equal(changelogUrlFor(undefined), null);
	});
	it("picks the versions after the installed one, up to the offered one, newest first", () => {
		assert.deepEqual(changesBetween(releases, "0.4.2106", "0.4.2108").map((e) => e.version), ["0.4.2108", "0.4.2107"]);
		assert.equal(changesBetween(releases, "0.4.2106", "0.4.2108")[1]!.notes, "");
		assert.deepEqual(changesBetween(releases, "0.4.2108", "0.4.2108"), []);
		assert.deepEqual(changesBetween("x", "0.4.2106", "0.4.2108"), []);
		assert.ok(compareVersions("0.4.10", "0.4.9") > 0);
	});
	it("any failure means no notes, never an error", async () => {
		const ok = (async () => Response.json({ releases })) as unknown as typeof fetch;
		assert.equal((await fetchChanges("https://h/download/changelog.json", "0.4.2105", "0.4.2108", ok)).length, 3);
		const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
		assert.deepEqual(await fetchChanges("https://h/x", "0.4.2105", "0.4.2108", down), []);
		const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
		assert.deepEqual(await fetchChanges("https://h/x", "0.4.2105", "0.4.2108", notFound), []);
		assert.deepEqual(await fetchChanges(null, "0.4.2105", "0.4.2108", ok), []);
	});
});
