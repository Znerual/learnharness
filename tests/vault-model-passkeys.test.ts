import assert from "node:assert/strict";
import { test } from "node:test";
import type { PasskeyRow } from "../src/core/vault/contract.ts";
import { initialPasskeys, passkeyCallReady, passkeyNoticeText, reducePasskeys, type PasskeysEvent, type PasskeysState } from "../src/core/vault/models/passkeys.ts";
import { reauthPasskeys } from "../src/core/vault/models/account.ts";

const rows: PasskeyRow[] = [
	{ id: "pk1", name: "Laptop", signInOnly: false },
	{ id: "pk2", name: "Old key", signInOnly: true },
];
const granted: PasskeysEvent = { type: "reauth", event: { type: "granted", reauthId: "h1", strength: "password", now: 1 } };

function loaded(available = true): PasskeysState {
	return reducePasskeys(initialPasskeys(), { type: "loaded", rows, availability: available ? { available: true } : { available: false, reason: "bridge_missing" }, reauthPasskeys: 2 });
}
const run = (s: PasskeysState, ...e: PasskeysEvent[]) => e.reduce(reducePasskeys, s);

test("add: name first, then re-authentication, then one call with the grant; the new key appears with its sign-in-only flag", () => {
	let s = run(loaded(), { type: "add_start" }, { type: "name_changed", name: "   " }, { type: "name_continue" });
	assert.equal(s.action?.kind === "add" && s.action.step, "name", "an empty name does not continue");
	assert.equal(s.error, "bad_request");
	s = run(s, { type: "name_changed", name: "  Phone  " }, { type: "name_continue" });
	assert.ok(s.action?.kind === "add" && s.action.step === "reauth" && s.action.name === "Phone");
	assert.equal(passkeyCallReady(s), null, "no call before the grant");
	s = run(s, granted);
	assert.deepEqual(passkeyCallReady(s), { op: "add", name: "Phone", reauthId: "h1" });
	s = run(s, { type: "submitted" });
	assert.equal(s.busy, true);
	assert.equal(passkeyCallReady(s), null, "the call is made once");
	s = run(s, { type: "added", row: { id: "pk3", name: "Phone", signInOnly: true } });
	assert.equal(s.action, null);
	assert.equal(s.rows.length, 3);
	assert.equal(s.reauthPasskeys, 3);
	assert.match(passkeyNoticeText(s.notice!), /Phone is added\. It signs in only/);
});

test("add is refused where the ceremony cannot run; the list still works", () => {
	const s = run(loaded(false), { type: "add_start" });
	assert.equal(s.action, null);
	assert.equal(s.rows.length, 2);
	assert.equal(s.availability?.available, false);
});

test("a failed add (closed window) asks for a fresh confirmation, because a grant is single-use", () => {
	let s = run(loaded(), { type: "add_start" }, { type: "name_changed", name: "Phone" }, { type: "name_continue" }, granted, { type: "submitted" }, { type: "failed", code: "passkey_cancelled" });
	assert.equal(s.error, "passkey_cancelled");
	assert.equal(s.busy, false);
	assert.ok(s.action?.kind === "add" && s.action.step === "reauth" && s.action.reauth.step === "form" && !s.action.submitted);
	s = run(s, { type: "cancel" });
	assert.equal(s.action, null);
});

test("remove: re-authenticate, then the row goes (applied) or a notice says it waits (pending)", () => {
	let s = run(loaded(), { type: "remove_ask", id: "pk1" }, granted);
	assert.deepEqual(passkeyCallReady(s), { op: "remove", passkeyId: "pk1", reauthId: "h1" });
	const applied = run(s, { type: "submitted" }, { type: "removed", outcome: { status: "applied", generation: 3 } });
	assert.deepEqual(applied.rows.map((r) => r.id), ["pk2"]);
	assert.equal(applied.reauthPasskeys, 1);
	assert.match(passkeyNoticeText(applied.notice!), /Laptop is removed/);
	const pending = run(s, { type: "submitted" }, { type: "removed", outcome: { status: "pending", pendingAction: { id: "p", kind: "revoke_device", strength: "password", requestedBy: null, requestedByName: "x", targetDeviceId: null, runsAt: "2026-11-02T10:00:00Z", createdAt: "2026-11-01T10:00:00Z", cancellable: true } } });
	assert.equal(pending.rows.length, 2, "a waiting removal keeps the row");
	assert.match(passkeyNoticeText(pending.notice!), /removal of Laptop is waiting/);
	assert.equal(run(loaded(), { type: "remove_ask", id: "nope" }).action, null);
});

test("cancel does not close a dialog while its call runs", () => {
	const s = run(loaded(), { type: "remove_ask", id: "pk1" }, granted, { type: "submitted" }, { type: "cancel" });
	assert.ok(s.action);
});

test("reauthPasskeys: zero where the ceremony cannot run, so the passkey method is not offered", () => {
	assert.equal(reauthPasskeys({ passkeys: 2, passkeyUsable: false }), 0);
	assert.equal(reauthPasskeys({ passkeys: 2, passkeyUsable: true }), 2);
	assert.equal(reauthPasskeys({ passkeys: 2 }), 2);
});
