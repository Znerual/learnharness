import assert from "node:assert/strict";
import { test } from "node:test";
import { passwordFeedback } from "../src/core/vault/models/password.ts";
import { initialSignup, reduceSignup, signupPasswordView, signupStepIndex, visibleSecrets, type SignupEvent, type SignupMaterial, type SignupState } from "../src/core/vault/models/signup.ts";

const material: SignupMaterial = {
	recoveryKey: "ABCD-EFGH-JKMN-PQRS",
	backupCodes: Array.from({ length: 10 }, (_, i) => `CODE-000${i}`),
	kit: { email: "a@b.co", serverUrl: "https://vault.example", recoveryKey: "ABCD-EFGH-JKMN-PQRS", recoveryKeyQr: "lhv1-recovery:x", createdAt: "2026-11-01T00:00:00Z" },
};

function run(s: SignupState, ...events: SignupEvent[]): SignupState {
	return events.reduce(reduceSignup, s);
}

function toPassword(): SignupState {
	return run(initialSignup(), { type: "email_changed", email: "a@b.co" }, { type: "submit_email" }, { type: "email_sent" }, { type: "code_changed", code: "ab12 cd34" }, { type: "submit_code" }, { type: "code_verified" });
}

test("email step rejects a malformed address without going busy", () => {
	const s = run(initialSignup(), { type: "email_changed", email: "nope" }, { type: "submit_email" });
	assert.equal(s.step, "email");
	assert.equal(s.busy, false);
	assert.equal(s.error, "bad_request");
});

test("email, code and password steps advance on server success", () => {
	const s = toPassword();
	assert.equal(s.step, "password");
	assert.equal(signupStepIndex(s), 2);
});

test("a short code does not submit", () => {
	const s = run(initialSignup("a@b.co"), { type: "submit_email" }, { type: "email_sent" }, { type: "code_changed", code: "123" }, { type: "submit_code" });
	assert.equal(s.step, "code");
	assert.equal(s.busy, false);
	assert.equal(s.error, "bad_code");
});

test("a failed server call keeps the step and shows the code", () => {
	const s = run(initialSignup("a@b.co"), { type: "submit_email" }, { type: "failed", code: "rate_limited" });
	assert.equal(s.step, "email");
	assert.equal(s.busy, false);
	assert.equal(s.error, "rate_limited");
});

test("busy state ignores a second submit", () => {
	const s = run(initialSignup("a@b.co"), { type: "submit_email" }, { type: "email_changed", email: "other@b.co" });
	assert.equal(s.step === "email" && s.email, "a@b.co");
});

test("password feedback is live: length first, then the server check", () => {
	assert.equal(passwordFeedback("short", null).rules[0]?.status, "fail");
	const long = "a-long-enough-pass";
	const pending = passwordFeedback(long, null);
	assert.equal(pending.acceptable, false);
	assert.equal(pending.needsCheck, true);
	assert.equal(pending.rules[2]?.status, "pending");
	const ok = passwordFeedback(long, { forPassword: long, result: { ok: true, onlineChecked: true } });
	assert.equal(ok.acceptable, true);
	const bad = passwordFeedback(long, { forPassword: long, result: { ok: false, reason: "breached", breachCount: 12345 } });
	assert.equal(bad.acceptable, false);
	assert.match(bad.rules[2]?.detail ?? "", /12,345/);
	// a result for an older password never counts
	assert.equal(passwordFeedback(long, { forPassword: "another-password-1", result: { ok: true, onlineChecked: true } }).acceptable, false);
	// an offline check passes but says it was skipped
	const offline = passwordFeedback(long, { forPassword: long, result: { ok: true, onlineChecked: false } });
	assert.equal(offline.acceptable, true);
	assert.match(offline.rules[2]?.detail ?? "", /offline/);
});

test("password step needs matching confirmation and an accepted password", () => {
	const pw = "correct-horse-staple";
	let s = run(toPassword(), { type: "password_changed", password: pw }, { type: "breach_result", password: pw, result: { ok: true, onlineChecked: true } });
	assert.equal(s.step === "password" && signupPasswordView(s).canSubmit, false);
	s = run(s, { type: "confirm_changed", confirm: "different" });
	assert.equal(s.step === "password" && signupPasswordView(s).mismatch, true);
	s = run(s, { type: "confirm_changed", confirm: pw });
	assert.equal(s.step === "password" && signupPasswordView(s).canSubmit, true);
	s = run(s, { type: "submit_password" });
	assert.equal(s.busy, true);
});

test("submit_password is ignored while a rule fails", () => {
	const s = run(toPassword(), { type: "password_changed", password: "short" }, { type: "confirm_changed", confirm: "short" }, { type: "submit_password" });
	assert.equal(s.busy, false);
});

function toSecrets(): SignupState {
	const pw = "correct-horse-staple";
	return run(toPassword(), { type: "password_changed", password: pw }, { type: "breach_result", password: pw, result: { ok: true, onlineChecked: true } }, { type: "confirm_changed", confirm: pw }, { type: "submit_password" }, { type: "finished", material });
}

test("secrets are visible only on the secrets and kit steps", () => {
	let s = toSecrets();
	assert.equal(s.step, "secrets");
	assert.deepEqual(visibleSecrets(s), material);
	// cannot continue before the learner acknowledges
	assert.equal(run(s, { type: "next" }).step, "secrets");
	s = run(s, { type: "acknowledged", value: true }, { type: "next" });
	assert.equal(s.step, "kit");
	assert.ok(visibleSecrets(s));
	s = run(s, { type: "kit_opened" }, { type: "next" });
	assert.equal(s.step, "confirm");
	assert.equal(visibleSecrets(s), null);
});

test("confirmation: wrong input counts an attempt, right input finishes and drops the secrets", () => {
	let s = run(toSecrets(), { type: "acknowledged", value: true }, { type: "next" }, { type: "next" }, { type: "typed_changed", typed: "xxxx" }, { type: "submit_confirm" });
	assert.equal(s.busy, true);
	s = run(s, { type: "confirm_result", ok: false });
	assert.equal(s.step, "confirm");
	assert.equal(s.error, "confirm_wrong");
	assert.equal(s.step === "confirm" && s.attempts, 1);
	s = run(s, { type: "typed_changed", typed: "S" }, { type: "submit_confirm" }, { type: "confirm_result", ok: true });
	assert.equal(s.step, "done");
	assert.equal("material" in s, false);
	assert.equal(visibleSecrets(s), null);
});

test("from confirm the learner can look at the secrets again", () => {
	const s = run(toSecrets(), { type: "acknowledged", value: true }, { type: "next" }, { type: "next" }, { type: "show_again" });
	assert.equal(s.step, "secrets");
	assert.equal(s.step === "secrets" && s.acknowledged, false);
});
