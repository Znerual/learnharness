"use strict";
/**
 * Signed update metadata (Vault builds, owner 2026-11-18). A Vault build takes its updates from the
 * vault host (learnharnessBuild.updateFeed). electron-updater trusts whatever that host serves:
 * the metadata file (latest-linux.yml, latest.yml) names an installer and its SHA-512, and the
 * installers are not code-signed. Whoever controls the host could therefore hand every installed
 * app a program of their choice.
 *
 * The release machine signs the metadata file with a key that never reaches the host, and puts
 * the signature beside it as <name>.sig. Before an update is downloaded, this module fetches the
 * metadata and its signature, checks the signature with the public key below, and checks that the
 * update electron-updater found is the one the signed file describes (same version, same
 * SHA-512 of every file). electron-updater then checks the download against that SHA-512.
 * No valid signature means no download.
 *
 * Signature format (learnharness-vault deploy/lan/sign-release.sh): one line of base64, the DER
 * ECDSA signature (curve P-256, SHA-256) over the exact bytes of the metadata file.
 */

const crypto = require("node:crypto");

/** Public keys that may sign releases. More than one only while a key is being replaced. */
const RELEASE_KEYS = [
	// learnharness-vault deploy/lan/release-signing.pub.pem; SHA-256 of the DER:
	// e73e5cf7c28d20403d032f66874b4507416757bc878595fcbb694795bc4d1084
	"-----BEGIN PUBLIC KEY-----\n" +
		"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELjgTrR07wKyQxhz8csKkE9HnX93G\n" +
		"XECnhiHg5LsoavcQ6sq0G4Q5tznHk2dGrbrorgXFJovuXpEtUC9JzdSbHw==\n" +
		"-----END PUBLIC KEY-----\n",
];

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** True when `signatureText` is a valid signature of `bytes` by one of `keys`. Never throws. */
function verifySignature(bytes, signatureText, keys = RELEASE_KEYS) {
	if (typeof signatureText !== "string") return false;
	const text = signatureText.trim();
	if (!text || text.length > MAX_SIGNATURE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
	const signature = Buffer.from(text, "base64");
	for (const key of keys) {
		try {
			if (crypto.verify("sha256", bytes, key, signature)) return true;
		} catch {
			// a malformed signature or key: not valid
		}
	}
	return false;
}

/** The metadata file electron-updater reads on this system (x64 builds only), or null. */
function metadataName(platform = process.platform) {
	if (platform === "linux") return "latest-linux.yml";
	if (platform === "win32") return "latest.yml";
	if (platform === "darwin") return "latest-mac.yml";
	return null;
}

/**
 * The version and the SHA-512 values of an electron-builder metadata file. The file is YAML, but
 * electron-builder writes a fixed, flat shape, and only these lines matter here:
 *   version: 1.2.3
 *   files:
 *     - url: NAME
 *       sha512: BASE64
 *   sha512: BASE64
 * Returns null for anything that does not have a version and at least one SHA-512.
 */
function parseMetadata(text) {
	if (typeof text !== "string") return null;
	let version = null;
	const sha512 = new Set();
	for (const raw of text.split(/\r?\n/)) {
		const v = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw);
		if (v) {
			if (version !== null) return null; // two versions: not a file electron-builder wrote
			version = v[1];
			continue;
		}
		const s = /^\s*sha512:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw);
		if (s) {
			if (!SHA512_B64.test(s[1])) return null;
			sha512.add(s[1]);
		}
	}
	if (!version || !VERSION.test(version) || sha512.size === 0) return null;
	return { version, sha512 };
}

/** True when the update electron-updater found is the one the signed metadata describes. */
function matchesSigned(info, signed) {
	if (!info || !signed || typeof info.version !== "string" || info.version !== signed.version) return false;
	const hashes = [];
	if (Array.isArray(info.files)) for (const f of info.files) hashes.push(f && f.sha512);
	if (info.sha512 !== undefined) hashes.push(info.sha512);
	if (hashes.length === 0) return false;
	return hashes.every((h) => typeof h === "string" && signed.sha512.has(h));
}

async function fetchBytes(url, max, fetchImpl) {
	const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "error" });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length > max) throw new Error(`${url} is larger than ${max} bytes`);
	return bytes;
}

/**
 * Checks the update `info` (electron-updater's UpdateInfo) against the signed metadata of `feed`.
 * Returns { ok: true } or { ok: false, reason }. Never throws.
 */
async function verifyUpdate(feed, info, { fetchImpl = globalThis.fetch, platform = process.platform, keys = RELEASE_KEYS } = {}) {
	try {
		const name = metadataName(platform);
		if (!name) return { ok: false, reason: `no update metadata for ${platform}` };
		if (typeof feed !== "string" || !/^https:\/\//.test(feed)) return { ok: false, reason: "the update feed is not an https URL" };
		const base = feed.endsWith("/") ? feed : `${feed}/`;
		const metadata = await fetchBytes(new URL(name, base).toString(), MAX_METADATA_BYTES, fetchImpl);
		const signature = await fetchBytes(new URL(`${name}.sig`, base).toString(), MAX_SIGNATURE_BYTES, fetchImpl);
		if (!verifySignature(metadata, signature.toString("utf8"), keys)) return { ok: false, reason: `${name} has no valid release signature` };
		const signed = parseMetadata(metadata.toString("utf8"));
		if (!signed) return { ok: false, reason: `${name} is signed but not readable` };
		if (!matchesSigned(info, signed)) return { ok: false, reason: `the update found (${info && info.version}) is not the one ${name} was signed for (${signed.version})` };
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `the release signature could not be checked: ${err && err.message ? err.message : err}` };
	}
}

module.exports = { RELEASE_KEYS, verifySignature, metadataName, parseMetadata, matchesSigned, verifyUpdate };
