"use strict";
/**
 * What's new in an update (Vault builds, owner 2026-11-02). The vault host
 * publishes /download/changelog.json beside the update feed (/updates/):
 * {releases: [{version, released, base?, notes?}]}, newest first
 * (learnharness-vault deploy/lan/publish-downloads.sh). When an update is
 * found, main.cjs reads it and the banner shows the entries after the
 * installed version, up to the offered one. Any failure means no notes,
 * never a failed update.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1, 0 or 1 for plain X.Y.Z versions; anything else ranks lowest. */
function compareVersions(a, b) {
	const p = (v) => {
		const m = VERSION.exec(String(v));
		return m ? m.slice(1).map(Number) : [-1, -1, -1];
	};
	const x = p(a);
	const y = p(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
	return 0;
}

/** The changelog URL beside a generic update feed ("https://host/updates/" → "https://host/download/changelog.json"), or null. */
function changelogUrlFor(feed) {
	if (typeof feed !== "string" || !/^https?:\/\//.test(feed)) return null;
	try {
		return new URL("../download/changelog.json", feed.endsWith("/") ? feed : `${feed}/`).toString();
	} catch {
		return null;
	}
}

/** The entries after `installed` up to and including `offered`, newest first, checked field by field (at most 20). */
function changesBetween(releases, installed, offered) {
	if (!Array.isArray(releases) || !VERSION.test(String(offered))) return [];
	const out = [];
	for (const e of releases) {
		if (!e || typeof e.version !== "string" || !VERSION.test(e.version)) continue;
		if (compareVersions(e.version, installed) <= 0 || compareVersions(e.version, offered) > 0) continue;
		out.push({
			version: e.version,
			released: typeof e.released === "string" ? e.released.slice(0, 20) : "",
			notes: typeof e.notes === "string" ? e.notes.slice(0, 8000) : "",
		});
	}
	return out.sort((a, b) => compareVersions(b.version, a.version)).slice(0, 20);
}

/** Reads the changelog and picks the entries for this update; [] on any failure. */
async function fetchChanges(url, installed, offered, fetchImpl = globalThis.fetch) {
	if (!url) return [];
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
		if (!res.ok) return [];
		const body = await res.json();
		return changesBetween(body && body.releases, installed, offered);
	} catch {
		return [];
	}
}

module.exports = { compareVersions, changelogUrlFor, changesBetween, fetchChanges };
