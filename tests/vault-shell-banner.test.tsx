import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import type { SyncState, SyncStatus } from "../src/core/vault/deps.ts";
import { shellBanner } from "../src/core/vault/models/syncStatus.ts";
import { ShellBannerView } from "../components/vault/ShellBanner.tsx";

const NOW = new Date("2026-11-01T12:00:00Z");
const o = { now: NOW, billingEnabled: false };
const signedIn = { state: "signed_in", accountId: "a", deviceId: "d", ephemeral: false, offline: false } as const;
const status = (state: SyncState, over: Partial<SyncStatus> = {}): SyncStatus => ({ state, pendingChanges: 0, lastSuccess: "2026-11-01T11:59:00Z", conflicts: 0, rollbacks: 0, rejected: 0, ...over });

test("shell banner: quiet while signed out, idle or syncing", () => {
	assert.equal(shellBanner({ state: "signed_out" }, null, o), null);
	assert.equal(shellBanner(signedIn, status("idle"), o), null);
	assert.equal(shellBanner(signedIn, status("syncing", { pendingChanges: 3 }), o), null);
	assert.equal(shellBanner(signedIn, null, o), null, "no answer yet");
});

test("shell banner: every problem state of the status model shows, with its own key and text", () => {
	const cases: [SyncState, RegExp, "info" | "warning" | "error", boolean][] = [
		["offline", /Offline/, "info", false],
		["error", /Sync problem/, "error", false],
		["over_quota", /vault is full/, "warning", true],
		["read_only", /read-only/, "warning", true],
		["rotation_rejected", /paused for safety/, "error", true],
		["revoked", /device was removed/, "error", true],
		["needs_unlock", /Unlock to keep syncing/, "warning", true],
	];
	const keys = new Set<string>();
	for (const [state, title, tone, blocked] of cases) {
		const b = shellBanner(signedIn, status(state), o);
		assert.ok(b, state);
		assert.match(b.title, title, state);
		assert.deepEqual([b.tone, b.blocked, b.key], [tone, blocked, state]);
		keys.add(b.key);
	}
	assert.equal(keys.size, cases.length);
});

test("shell banner: session states that stop sync show too (joining, new password, locked)", () => {
	assert.match(shellBanner({ state: "joining", email: "a@b.co", localFiles: 2 }, null, o)?.title ?? "", /Finish joining the vault/);
	assert.match(shellBanner({ state: "must_set_password" }, null, o)?.title ?? "", /new password/);
	assert.match(shellBanner({ state: "needs_unlock", email: "a@b.co" }, null, o)?.title ?? "", /Unlock to keep syncing/);
});

test("shell banner view: nothing for a quiet state; a card with a link to the vault settings otherwise", () => {
	const noop = () => undefined;
	assert.equal(renderToString(<ShellBannerView banner={null} onOpen={noop} onDismiss={noop} />), "");
	const html = renderToString(<ShellBannerView banner={shellBanner(signedIn, status("over_quota"), o)} onOpen={noop} onDismiss={noop} />);
	assert.match(html, /data-testid="vault-shell-banner"/);
	assert.match(html, /data-key="over_quota"/);
	assert.match(html, /Your vault is full/);
	assert.match(html, /Open vault settings/);
	assert.match(html, /aria-label="Dismiss"/);
	assert.match(renderToString(<ShellBannerView banner={shellBanner(signedIn, status("revoked"), o)} onOpen={noop} onDismiss={noop} />), /role="alert"/);
});
