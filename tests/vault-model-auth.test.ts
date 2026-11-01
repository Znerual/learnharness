import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionDto } from "../src/core/vault/contract.ts";
import { initialRecover, reduceRecover, recoverPasswordView } from "../src/core/vault/models/recover.ts";
import { initialSignIn, reduceSignIn } from "../src/core/vault/models/signin.ts";
import { initialUnlock, reduceUnlock, unlockView } from "../src/core/vault/models/unlock.ts";

const signedIn: SessionDto = { state: "signed_in", accountId: "a", deviceId: "d", ephemeral: false, offline: false };

test("password sign-in: submit goes busy, session signed_in finishes", () => {
	let s = reduceSignIn(initialSignIn(), { type: "email_changed", email: "a@b.co" });
	s = reduceSignIn(s, { type: "password_changed", password: "pw" });
	s = reduceSignIn(s, { type: "submit_password" });
	assert.equal(s.busy, true);
	assert.equal(reduceSignIn(s, { type: "submit_password" }), s);
	s = reduceSignIn(s, { type: "session", session: signedIn });
	assert.equal(s.step, "signed_in");
});

test("wrong password keeps the form and shows login_failed", () => {
	let s = reduceSignIn(initialSignIn("a@b.co"), { type: "password_changed", password: "pw" });
	s = reduceSignIn(reduceSignIn(s, { type: "submit_password" }), { type: "failed", code: "login_failed" });
	assert.equal(s.step, "form");
	assert.equal(s.busy, false);
	assert.equal(s.error, "login_failed");
});

test("passkey with PRF unlocks directly", () => {
	let s = reduceSignIn(initialSignIn("a@b.co"), { type: "passkey_started" });
	assert.equal(s.step === "form" && s.passkeyWaiting, true);
	s = reduceSignIn(s, { type: "session", session: signedIn });
	assert.equal(s.step, "signed_in");
});

test("passkey without PRF: signed in but needs unlock, then the three choices", () => {
	let s = reduceSignIn(initialSignIn("a@b.co"), { type: "passkey_started" });
	s = reduceSignIn(s, { type: "session", session: { state: "needs_unlock", email: "a@b.co" } });
	assert.equal(s.step, "needs_unlock");
	// password path
	let p = reduceSignIn(s, { type: "password_changed", password: "pw" });
	p = reduceSignIn(p, { type: "submit_unlock" });
	assert.equal(p.busy, true);
	assert.equal(reduceSignIn(p, { type: "session", session: signedIn }).step, "signed_in");
	// pairing and recovery hand off to other screens
	const pair = reduceSignIn(s, { type: "choose", choice: "pairing" });
	assert.deepEqual(pair, { step: "handoff", to: "pairing", email: "a@b.co", busy: false });
	const rec = reduceSignIn(s, { type: "choose", choice: "recovery" });
	assert.equal(rec.step === "handoff" && rec.to, "recover");
});

test("cancelled passkey prompt returns to the form with a message", () => {
	const s = reduceSignIn(reduceSignIn(initialSignIn("a@b.co"), { type: "passkey_started" }), { type: "passkey_cancelled" });
	assert.equal(s.step === "form" && s.passkeyWaiting, false);
	assert.equal(s.step === "form" && s.error, "passkey_cancelled");
});

test("a passkey sign-in without an email does not start", () => {
	const s = reduceSignIn(initialSignIn(), { type: "passkey_started" });
	assert.equal(s.busy, false);
	assert.equal(s.step === "form" && s.error, "bad_request");
});

test("unlock on launch covers every session state", () => {
	assert.equal(reduceUnlock(initialUnlock, { type: "session", session: signedIn }).step, "ready");
	const off = reduceUnlock(initialUnlock, { type: "session", session: { ...signedIn, offline: true } });
	assert.equal(unlockView(off).appUsable, true);
	assert.match(unlockView(off).title, /offline/i);
	assert.equal(unlockView(reduceUnlock(initialUnlock, { type: "session", session: { state: "signed_out" } })).action, "sign_in");
	assert.equal(reduceUnlock(initialUnlock, { type: "session", session: { state: "needs_unlock", email: "a@b.co" } }).step, "needs_unlock");
	assert.equal(unlockView(reduceUnlock(initialUnlock, { type: "session", session: { state: "must_set_password" } })).action, "set_password");
	const expired = reduceUnlock(initialUnlock, { type: "failed", code: "signed_out" });
	assert.deepEqual(expired, { step: "signed_out", reason: "expired" });
	assert.equal(unlockView(expired).appUsable, false);
	assert.equal(unlockView(reduceUnlock(initialUnlock, { type: "failed", code: "internal" })).action, "retry");
});

test("recovery: secret first, then a forced new password, then done", () => {
	let s = reduceRecover(initialRecover(), { type: "email_changed", email: "a@b.co" });
	s = reduceRecover(s, { type: "secret_changed", secret: "ab" });
	assert.equal(reduceRecover(s, { type: "submit_secret" }).busy, false);
	s = reduceRecover(s, { type: "secret_changed", secret: "ABCD-EFGH-JKMN-PQRS" });
	s = reduceRecover(s, { type: "submit_secret" });
	assert.equal(s.busy, true);
	s = reduceRecover(s, { type: "session", session: { state: "must_set_password" } });
	assert.equal(s.step, "new_password");
	const pw = "a-new-long-password";
	s = reduceRecover(s, { type: "password_changed", password: pw });
	s = reduceRecover(s, { type: "confirm_changed", confirm: pw });
	assert.equal(s.step === "new_password" && recoverPasswordView(s).canSubmit, false, "needs the breach check result");
	s = reduceRecover(s, { type: "breach_result", password: pw, result: { ok: true, onlineChecked: true } });
	assert.equal(s.step === "new_password" && recoverPasswordView(s).canSubmit, true);
	s = reduceRecover(s, { type: "submit_password" });
	assert.equal(s.busy, true);
	s = reduceRecover(s, { type: "password_set", pending: false });
	assert.deepEqual(s, { step: "done", pending: false, busy: false });
});

test("a wrong recovery secret shows the error and stays on the form", () => {
	let s = reduceRecover(initialRecover("form", "a@b.co"), { type: "secret_changed", secret: "ABCD-EFGH-JKMN-PQRS" });
	s = reduceRecover(reduceRecover(s, { type: "submit_secret" }), { type: "failed", code: "no_method" });
	assert.equal(s.step, "form");
	assert.equal(s.step === "form" && s.error, "no_method");
});

test("a device that must set a password can start at the new-password step", () => {
	assert.equal(initialRecover("new_password").step, "new_password");
});
