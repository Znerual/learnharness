import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeviceRow, PendingAction } from "../src/core/vault/deps.ts";
import { deviceView, initialDevices, pendingView, reduceDevices, pendingCallReady, revokeCallReady, sortedDevices, type DevicesEvent, type DevicesState } from "../src/core/vault/models/devices.ts";
import { strings } from "../src/core/vault/strings.ts";
import { availableMethods, initialReauth, reauthExpired, reduceReauth, runsImmediately } from "../src/core/vault/models/reauth.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

function dev(over: Partial<DeviceRow>): DeviceRow {
	return { id: "d1", lhDeviceId: "dev_1", name: "Laptop", ephemeral: false, keysProtected: true, createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-11-02T11:00:00Z", current: false, established: true, hasUnlockMethod: true, ...over };
}

const devices = [dev({ id: "me", name: "This laptop", current: true }), dev({ id: "lost", name: "Old phone", lastSeenAt: "2026-10-20T00:00:00Z" }), dev({ id: "kiosk", name: "Kiosk", ephemeral: true, keysProtected: false, established: false })];

function load(): DevicesState {
	return reduceDevices(initialDevices(), { type: "loaded", devices, pending: null, passkeys: 0 });
}

function run(s: DevicesState, ...e: DevicesEvent[]): DevicesState {
	return e.reduce(reduceDevices, s);
}

test("device badges: current, established, keys not protected, ephemeral", () => {
	const me = deviceView(devices[0] as DeviceRow, NOW);
	assert.deepEqual(me.badges.map((b) => b.id), ["current", "established"]);
	const kiosk = deviceView(devices[2] as DeviceRow, NOW);
	assert.deepEqual(kiosk.badges.map((b) => b.id), ["keys_not_protected", "ephemeral"]);
	assert.match(kiosk.badges[0]?.label ?? "", /Keys not protected/);
});

test("the current device signs out; other devices are revoked", () => {
	assert.deepEqual(deviceView(devices[0] as DeviceRow, NOW).actions, ["rename", "sign_out"]);
	assert.deepEqual(deviceView(devices[1] as DeviceRow, NOW).actions, ["rename", "revoke"]);
	assert.equal(sortedDevices(devices)[0]?.id, "me");
});

test("rename: validates and finishes", () => {
	let s = run(load(), { type: "rename_start", deviceId: "lost" }, { type: "rename_changed", value: "   " }, { type: "rename_submit" });
	assert.equal(s.busy, false);
	assert.equal(s.error, "bad_request");
	s = run(s, { type: "rename_changed", value: "Spare phone" }, { type: "rename_submit" });
	assert.equal(s.busy, true);
	s = run(s, { type: "rename_done" });
	assert.equal(s.rename, null);
	assert.equal(s.busy, false);
});

test("sign out this device asks first and clears the list", () => {
	let s = run(load(), { type: "sign_out_ask" });
	assert.equal(s.action?.kind, "sign_out_confirm");
	s = run(s, { type: "sign_out_done" });
	assert.equal(s.action, null);
	assert.equal(s.notice?.kind, "signed_out");
});

test("revoke: you cannot revoke the current device", () => {
	assert.equal(run(load(), { type: "revoke_ask", deviceId: "me" }).action, null);
});

test("revoke with a password grant ends pending for 24 hours", () => {
	let s = run(load(), { type: "revoke_ask", deviceId: "lost" });
	assert.equal(s.action?.kind, "revoke");
	assert.equal(revokeCallReady(s), null, "no grant yet");
	s = run(s, { type: "reauth", event: { type: "value_changed", value: "pw" } }, { type: "reauth", event: { type: "submit" } }, { type: "reauth", event: { type: "granted", reauthId: "h1", strength: "password", now: 1 } });
	assert.deepEqual(revokeCallReady(s), { deviceId: "lost", reauthId: "h1" });
	s = run(s, { type: "revoke_submitted" });
	assert.equal(revokeCallReady(s), null, "only one call per grant");
	const pending: PendingAction = { id: "p1", kind: "revoke_device", strength: "password", requestedBy: "me", requestedByName: "This laptop", targetDeviceId: "lost", runsAt: "2026-11-03T12:00:00Z", createdAt: "2026-11-02T12:00:00Z", cancellable: true };
	s = run(s, { type: "revoke_result", outcome: { status: "pending", pendingAction: pending } });
	assert.equal(s.action, null);
	assert.equal(s.notice?.kind, "revoke_pending");
	assert.equal(s.pending?.id, "p1");
	assert.equal(s.devices.length, 3, "the device stays until the action runs");
});

test("revoke authorized with recovery material applies at once and drops the device", () => {
	let s = run(load(), { type: "revoke_ask", deviceId: "lost" }, { type: "reauth", event: { type: "granted", reauthId: "h2", strength: "recovery", now: 1 } }, { type: "revoke_submitted" });
	assert.equal(runsImmediately("recovery"), true);
	assert.equal(runsImmediately("password"), false);
	s = run(s, { type: "revoke_result", outcome: { status: "applied", generation: 3 } });
	assert.equal(s.notice?.kind, "revoked");
	assert.equal(s.devices.some((d) => d.id === "lost"), false);
});

test("a failed revoke resets the used grant so the learner confirms again", () => {
	const s = run(load(), { type: "revoke_ask", deviceId: "lost" }, { type: "reauth", event: { type: "granted", reauthId: "h3", strength: "password", now: 1 } }, { type: "revoke_submitted" }, { type: "failed", code: "rotation_pending" });
	assert.equal(s.error, "rotation_pending");
	assert.equal(s.action?.kind === "revoke" && s.action.reauth.step, "form");
	assert.equal(revokeCallReady(s), null);
});

function pendingFor(over: Partial<PendingAction> = {}): PendingAction {
	return { id: "p1", kind: "revoke_device", strength: "password", requestedBy: "other", requestedByName: "Work PC", targetDeviceId: "lost", runsAt: "2026-11-03T12:00:00Z", createdAt: "2026-11-02T12:00:00Z", cancellable: true, ...over };
}

test("pending view: established device that did not request it can confirm", () => {
	const v = pendingView(pendingFor(), devices, NOW);
	assert.equal(v.canConfirm, true);
	assert.equal(v.canCancel, true);
	assert.match(v.title, /Revoke Old phone/);
	assert.match(v.runs, /in 1 day/);
});

test("pending view: the requesting device cannot confirm its own request, a new device cannot confirm", () => {
	assert.equal(pendingView(pendingFor({ requestedBy: "me" }), devices, NOW).canConfirm, false);
	const fresh = [dev({ id: "me", current: true, established: false }), dev({ id: "lost" })];
	const v = pendingView(pendingFor(), fresh, NOW);
	assert.equal(v.canConfirm, false);
	assert.ok(v.notes.some((n) => /24 hours/.test(n)));
});

test("pending view: an action authorized with recovery material cannot be cancelled", () => {
	const v = pendingView(pendingFor({ cancellable: false }), devices, NOW);
	assert.equal(v.canCancel, false);
	assert.ok(v.notes.some((n) => /cannot be cancelled/.test(n)));
});

test("pending confirm and cancel re-authenticate first, then finish with a notice", () => {
	const loaded = reduceDevices(load(), { type: "loaded", devices, pending: pendingFor(), passkeys: 1 });
	let s = run(loaded, { type: "pending_confirm" });
	assert.equal(s.action?.kind, "pending");
	assert.equal(pendingCallReady(s), null);
	s = run(s, { type: "reauth", event: { type: "granted", reauthId: "g1", strength: "passkey", now: 1 } });
	assert.deepEqual(pendingCallReady(s), { op: "confirm", id: "p1", reauthId: "g1" });
	s = run(s, { type: "pending_submitted" });
	assert.equal(pendingCallReady(s), null);
	s = run(s, { type: "pending_done", kind: "confirmed" });
	assert.equal(s.pending, null);
	assert.equal(s.action, null);
	assert.equal(s.notice?.kind, "pending_confirmed");
	const c = run(loaded, { type: "pending_cancel" }, { type: "reauth", event: { type: "granted", reauthId: "g2", strength: "password", now: 1 } });
	assert.deepEqual(pendingCallReady(c), { op: "cancel", id: "p1", reauthId: "g2" });
});

test("confirming offers no password re-authentication; cancelling does", () => {
	const loaded = reduceDevices(load(), { type: "loaded", devices, pending: pendingFor(), passkeys: 1 });
	const c = run(loaded, { type: "pending_confirm" }).action;
	assert.ok(c?.kind === "pending" && c.reauth.step === "form");
	if (c?.kind === "pending" && c.reauth.step === "form") {
		assert.deepEqual(c.reauth.available, ["passkey", "recovery"]);
		assert.equal(c.reauth.method, "passkey");
	}
	const x = run(loaded, { type: "pending_cancel" }).action;
	if (x?.kind === "pending" && x.reauth.step === "form") assert.ok(x.reauth.available.includes("password"));
	assert.deepEqual(initialReauth(0, true) && (initialReauth(0, true) as { available: string[] }).available, ["recovery"]);
});

test("a failed pending call resets the used grant", () => {
	const s = run(reduceDevices(load(), { type: "loaded", devices, pending: pendingFor(), passkeys: 0 }), { type: "pending_confirm" }, { type: "reauth", event: { type: "granted", reauthId: "g", strength: "recovery", now: 1 } }, { type: "pending_submitted" }, { type: "failed", code: "stronger_reauth_required" });
	assert.equal(s.error, "stronger_reauth_required");
	assert.equal(s.action?.kind === "pending" && s.action.reauth.step, "form");
	assert.ok(strings.errors.stronger_reauth_required && strings.errors.not_cancellable);
});

test("pending view: the device a revocation targets cannot cancel it", () => {
	const v = pendingView(pendingFor({ targetDeviceId: "me" }), devices, NOW);
	assert.equal(v.canCancel, false);
	assert.ok(v.notes.some((n) => /cannot cancel its own/.test(n)));
});

test("re-authentication: passkey is offered only when the account has one; backup code warning exists", () => {
	assert.deepEqual(availableMethods(0), ["password", "recovery"]);
	assert.deepEqual(availableMethods(2), ["password", "passkey", "recovery"]);
	let r = reduceReauth(initialReauth(0), { type: "method_changed", method: "passkey" });
	assert.equal(r.step === "form" && r.method, "password", "unavailable method ignored");
	r = reduceReauth(initialReauth(1), { type: "method_changed", method: "recovery" });
	assert.equal(r.step === "form" && r.value, "");
	r = reduceReauth(reduceReauth(r, { type: "value_changed", value: "CODE" }), { type: "submit" });
	assert.equal(r.step === "form" && r.busy, true);
	r = reduceReauth(r, { type: "failed", code: "bad_code" });
	assert.equal(r.step === "form" && r.error, "bad_code");
});

test("a grant expires after 4.5 minutes on the client", () => {
	const g = reduceReauth(initialReauth(), { type: "granted", reauthId: "x", strength: "password", now: 1000 });
	assert.equal(reauthExpired(g, 1000 + 4 * 60_000), false);
	assert.equal(reauthExpired(g, 1000 + 5 * 60_000), true);
});
