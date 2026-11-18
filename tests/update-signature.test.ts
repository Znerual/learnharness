/**
 * Signed update metadata (owner, 2026-11-18). A Vault build updates from the vault host, and its
 * installers are not code-signed. The app downloads an update only when the metadata that names
 * it carries a signature of the release key, which never reaches that host.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { RELEASE_KEYS, verifySignature, metadataName, parseMetadata, matchesSigned, verifyUpdate } = require("../electron/update-signature.cjs") as {
	RELEASE_KEYS: string[];
	verifySignature(bytes: Uint8Array, signature: unknown, keys?: string[]): boolean;
	metadataName(platform?: string): string | null;
	parseMetadata(text: unknown): { version: string; sha512: Set<string> } | null;
	matchesSigned(info: unknown, signed: unknown): boolean;
	verifyUpdate(feed: unknown, info: unknown, o?: { fetchImpl?: typeof fetch; platform?: string; keys?: string[] }): Promise<{ ok: boolean; reason?: string }>;
};
const { fetchChanges } = require("../electron/changelog.cjs") as {
	fetchChanges(url: string | null, installed: string, offered: string, f?: typeof fetch, verify?: ((b: Uint8Array, s: string) => boolean) | null): Promise<{ version: string }[]>;
};

const pair = () => {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	return { pem: publicKey.export({ type: "spki", format: "pem" }) as string, sign: (b: Uint8Array) => sign("sha256", b, privateKey).toString("base64") };
};
const sha = (c: string) => `${c.repeat(86)}==`;
const yml = (version: string, hash = sha("A")) => `version: ${version}\nfiles:\n  - url: LearnHarness-${version}-x86_64.AppImage\n    sha512: ${hash}\n    size: 201401281\n    blockMapSize: 211111\npath: LearnHarness-${version}-x86_64.AppImage\nsha512: ${hash}\nreleaseDate: '2026-11-18T21:28:00.000Z'\n`;
const info = (version: string, hash = sha("A")) => ({ version, files: [{ url: `LearnHarness-${version}-x86_64.AppImage`, sha512: hash, size: 201401281 }], path: "x", sha512: hash });
const feedOf = (files: Record<string, string>) => {
	const seen: string[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		seen.push(url);
		assert.equal(init?.redirect, "error");
		const name = url.slice(url.lastIndexOf("/") + 1);
		return name in files ? new Response(files[name]) : new Response("", { status: 404 });
	}) as unknown as typeof fetch;
	return { f, seen };
};

describe("release signatures", () => {
	it("accepts a signature of the release key and nothing else", () => {
		const a = pair();
		const b = pair();
		const data = Buffer.from(yml("0.6.2105"));
		const sig = a.sign(data);
		assert.ok(verifySignature(data, sig, [a.pem]));
		assert.ok(verifySignature(data, `  ${sig}\n`, [a.pem]), "whitespace around the signature");
		assert.ok(verifySignature(data, sig, [b.pem, a.pem]), "any listed key");
		assert.ok(!verifySignature(data, sig, [b.pem]), "another key");
		assert.ok(!verifySignature(Buffer.from(yml("0.6.2106")), sig, [a.pem]), "other bytes");
		for (const bad of ["", "   ", "not base64!", sig.slice(0, 20), "A".repeat(5000), undefined, null, 7])
			assert.ok(!verifySignature(data, bad, [a.pem]), `refused: ${String(bad).slice(0, 12)}`);
		assert.ok(!verifySignature(data, sig, ["not a key"]));
		assert.ok(!verifySignature(data, sig, []));
	});

	it("the built-in key verifies a signature made with the release key", () => {
		assert.equal(RELEASE_KEYS.length, 1);
		assert.ok(verifySignature(Buffer.from("hello"), "MEUCIQDY1miCURcFxI6KUUf2I3GT3xXP6I0kDlXKJKqaSaYP+wIgLzwbyacZiqhmSmgwUuIQCkOYsXWbc/0gTjS7hmss3j8="));
		assert.ok(!verifySignature(Buffer.from("hellO"), "MEUCIQDY1miCURcFxI6KUUf2I3GT3xXP6I0kDlXKJKqaSaYP+wIgLzwbyacZiqhmSmgwUuIQCkOYsXWbc/0gTjS7hmss3j8="));
	});

	it("reads electron-builder's metadata and nothing looser", () => {
		const m = parseMetadata(yml("0.6.2105", sha("B")));
		assert.equal(m?.version, "0.6.2105");
		assert.deepEqual([...(m?.sha512 ?? [])], [sha("B")]);
		assert.equal(parseMetadata("version: 1.0.0\n"), null, "no hash");
		assert.equal(parseMetadata(`sha512: ${sha("A")}\n`), null, "no version");
		assert.equal(parseMetadata(`version: 1.0.0\nversion: 9.9.9\nsha512: ${sha("A")}\n`), null, "two versions");
		assert.equal(parseMetadata("version: 1.0.0-beta\nsha512: " + sha("A") + "\n"), null, "not a plain version");
		assert.equal(parseMetadata("version: 1.0.0\nsha512: short\n"), null);
		assert.equal(parseMetadata(undefined), null);
		assert.equal(metadataName("linux"), "latest-linux.yml");
		assert.equal(metadataName("win32"), "latest.yml");
		assert.equal(metadataName("freebsd"), null);
	});

	it("the update found must be the update that was signed", () => {
		const signed = parseMetadata(yml("0.6.2105"));
		assert.ok(matchesSigned(info("0.6.2105"), signed));
		assert.ok(!matchesSigned(info("0.6.2106"), signed), "another version");
		assert.ok(!matchesSigned(info("0.6.2105", sha("C")), signed), "another installer");
		assert.ok(!matchesSigned({ version: "0.6.2105", files: [] }, signed), "no hash to compare");
		assert.ok(!matchesSigned({ version: "0.6.2105", files: [{ sha512: sha("A") }, { sha512: sha("C") }] }, signed), "one file unsigned");
		assert.ok(!matchesSigned(null, signed));
	});

	it("checks the feed's metadata before a download", async () => {
		const k = pair();
		const text = yml("0.6.2105");
		const good = feedOf({ "latest-linux.yml": text, "latest-linux.yml.sig": k.sign(Buffer.from(text)) });
		assert.deepEqual(await verifyUpdate("https://h/updates/2/", info("0.6.2105"), { fetchImpl: good.f, platform: "linux", keys: [k.pem] }), { ok: true });
		assert.deepEqual(good.seen, ["https://h/updates/2/latest-linux.yml", "https://h/updates/2/latest-linux.yml.sig"]);
		assert.ok((await verifyUpdate("https://h/updates/2", info("0.6.2105"), { fetchImpl: good.f, platform: "linux", keys: [k.pem] })).ok, "feed without a trailing slash");

		const refused = async (files: Record<string, string>, i: unknown = info("0.6.2105"), feed: unknown = "https://h/updates/2/") => {
			const r = await verifyUpdate(feed, i, { fetchImpl: feedOf(files).f, platform: "linux", keys: [k.pem] });
			assert.equal(r.ok, false);
			return r.reason ?? "";
		};
		assert.match(await refused({ "latest-linux.yml": text }), /could not be checked/, "no signature file");
		assert.match(await refused({ "latest-linux.yml": text, "latest-linux.yml.sig": pair().sign(Buffer.from(text)) }), /no valid release signature/);
		// The host swaps the installer: it must change the metadata, and then the signature no longer fits.
		const swapped = yml("0.6.2105", sha("E"));
		assert.match(await refused({ "latest-linux.yml": swapped, "latest-linux.yml.sig": k.sign(Buffer.from(text)) }, info("0.6.2105", sha("E"))), /no valid release signature/);
		// The host answers the updater with other metadata than the signed file.
		assert.match(await refused({ "latest-linux.yml": text, "latest-linux.yml.sig": k.sign(Buffer.from(text)) }, info("0.6.2105", sha("E"))), /not the one/);
		assert.match(await refused({ "latest-linux.yml": text, "latest-linux.yml.sig": k.sign(Buffer.from(text)) }, info("0.6.2999")), /not the one/);
		assert.match(await refused({}, info("0.6.2105"), "http://h/updates/2/"), /not an https URL/);
		const huge = "x".repeat(70_000);
		assert.match(await refused({ "latest-linux.yml": huge, "latest-linux.yml.sig": k.sign(Buffer.from(huge)) }), /larger than/);
		const r = await verifyUpdate("https://h/u/", info("1.0.0"), { fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, platform: "linux" });
		assert.equal(r.ok, false);
	});

	it("change notes of a signed feed are shown only with a valid signature", async () => {
		const k = pair();
		const body = JSON.stringify({ releases: [{ version: "0.6.2105", released: "2026-11-18", notes: "- signed" }] });
		const verify = (b: Uint8Array, s: string) => verifySignature(b, s, [k.pem]);
		const url = "https://h/download/changelog.json";
		assert.equal((await fetchChanges(url, "0.6.2104", "0.6.2105", feedOfPlain({ "changelog.json": body, "changelog.json.sig": k.sign(Buffer.from(body)) }), verify)).length, 1);
		assert.deepEqual(await fetchChanges(url, "0.6.2104", "0.6.2105", feedOfPlain({ "changelog.json": body }), verify), []);
		assert.deepEqual(await fetchChanges(url, "0.6.2104", "0.6.2105", feedOfPlain({ "changelog.json": body, "changelog.json.sig": pair().sign(Buffer.from(body)) }), verify), []);
		assert.equal((await fetchChanges(url, "0.6.2104", "0.6.2105", feedOfPlain({ "changelog.json": body }))).length, 1, "a feed without signatures (GitHub, developer override)");
	});

	it("the main process downloads from its own feed only after the check", () => {
		const main = readFileSync(fileURLToPath(new URL("../electron/main.cjs", import.meta.url)), "utf8");
		assert.match(main, /signedFeed = BUILD\.updateFeed;/);
		assert.match(main, /autoUpdater\.autoDownload = !signedFeed;/);
		const handler = main.slice(main.indexOf('autoUpdater.on("update-available"'), main.indexOf('autoUpdater.on("update-not-available"'));
		assert.ok(handler.indexOf("verifyUpdate(signedFeed, info)") >= 0 && handler.indexOf("verifyUpdate(signedFeed, info)") < handler.indexOf("autoUpdater.downloadUpdate()"), "verify, then download");
		const refusal = handler.slice(handler.indexOf("if (!check.ok) {"), handler.indexOf("autoUpdater.downloadUpdate()"));
		assert.match(refusal, /reportUpdateStatus\("error"\);\s*return;\s*\}/, "a failed check ends without a download");
	});
});

function feedOfPlain(files: Record<string, string>): typeof fetch {
	return (async (url: string) => {
		const name = url.slice(url.lastIndexOf("/") + 1);
		return name in files ? new Response(files[name]) : new Response("", { status: 404 });
	}) as unknown as typeof fetch;
}
