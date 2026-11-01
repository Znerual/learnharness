import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import type { PendingAction } from "../src/core/vault/deps.ts";
import { initialChangePassword, initialRegenerate, reduceChangePassword, reduceRegenerate, type ChangePasswordEvent, type RegenerateEvent } from "../src/core/vault/models/account.ts";
import { initialPasskeys, reducePasskeys, type PasskeysEvent } from "../src/core/vault/models/passkeys.ts";
import { initialSignIn } from "../src/core/vault/models/signin.ts";
import { ChangePasswordView } from "../components/vault/ChangePassword.tsx";
import { PasskeysView } from "../components/vault/Passkeys.tsx";
import { RegenerateView } from "../components/vault/Regenerate.tsx";
import { SignInView } from "../components/vault/SignIn.tsx";

const noop = () => undefined;
const RK = "QWER-TYUI-OPAS-DFGH-JKLZ";
const CODES = Array.from({ length: 10 }, (_, i) => `BKUP-${1000 + i}`);
const kit = { email: "learner@example.org", serverUrl: "https://vault.example.org", recoveryKey: RK, recoveryKeyQr: `lhv1-recovery:x:${RK}`, createdAt: "2026-11-01T10:00:00Z" };
const pending: PendingAction = { id: "p1", kind: "regenerate_backup_codes", strength: "password", requestedBy: "d", requestedByName: "Laptop", targetDeviceId: null, runsAt: "2026-11-02T10:00:00Z", createdAt: "2026-11-01T10:00:00Z", cancellable: true };
const granted = { type: "reauth", event: { type: "granted", reauthId: "h", strength: "password", now: 1 } } as const;

// ---------------------------------------------------------------- change password

function changePassword(...events: ChangePasswordEvent[]) {
	const pw = "a-long-new-password-1";
	let s = reduceChangePassword(initialChangePassword(), { type: "password_changed", password: pw });
	s = reduceChangePassword(s, { type: "confirm_changed", confirm: pw });
	s = reduceChangePassword(s, { type: "breach_result", password: pw, result: { ok: true, onlineChecked: true } });
	return events.reduce((x, e) => reduceChangePassword(x, e), s);
}
const renderCp = (s: ReturnType<typeof changePassword>) => renderToString(<ChangePasswordView state={s} dispatch={noop} onContinue={noop} reauthSlot={() => <div data-testid="reauth-stub">reauth</div>} />);

test("change password: form with the rules, then re-authentication, then done", () => {
	const form = renderCp(changePassword());
	assert.match(form, /data-step="form"/);
	assert.match(form, /At least 12 characters/);
	assert.match(form, /Repeat the new password/);
	const reauth = renderCp(changePassword({ type: "continue" }));
	assert.match(reauth, /data-step="reauth"/);
	assert.match(reauth, /data-testid="reauth-stub"/);
	const done = renderCp(changePassword({ type: "continue" }, granted, { type: "submitted" }, { type: "changed", rotation: { status: "applied", generation: 2 } }));
	assert.match(done, /Your password is changed/);
	assert.doesNotMatch(done, /change-password-pending/);
});

test("change password: a waiting rotation says so; the typed password is gone from the done screen", () => {
	const html = renderCp(changePassword({ type: "continue" }, granted, { type: "submitted" }, { type: "changed", rotation: { status: "pending", pendingAction: pending } }));
	assert.match(html, /data-testid="change-password-pending"/);
	assert.match(html, /runs in 24 hours/);
	assert.ok(!html.includes("a-long-new-password-1"));
});

test("change password: the continue button is disabled until the password is acceptable", () => {
	const empty = renderToString(<ChangePasswordView state={initialChangePassword()} dispatch={noop} onContinue={noop} />);
	assert.match(empty, /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
	assert.doesNotMatch(renderCp(changePassword()), /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
});

// ---------------------------------------------------------------- regenerate

function regen(...events: RegenerateEvent[]) {
	return events.reduce(reduceRegenerate, initialRegenerate);
}
const renderRegen = (s: ReturnType<typeof regen>, left?: number) => renderToString(<RegenerateView state={s} dispatch={noop} onStart={noop} {...(left === undefined ? {} : { backupCodesLeft: left })} reauthSlot={() => <div data-testid="reauth-stub" />} />);

test("regenerate: start buttons, then re-authentication", () => {
	const idle = renderRegen(regen());
	assert.match(idle, /Replace recovery key/);
	assert.match(idle, /Replace backup codes/);
	assert.match(renderRegen(regen({ type: "start", kind: "recovery_key", passkeys: 0 })), /data-testid="reauth-stub"/);
});

test("regenerate: the new recovery key and the kit appear once, on the show step only", () => {
	const show = regen({ type: "start", kind: "recovery_key", passkeys: 0 }, granted, { type: "submitted" }, { type: "result", rotation: { status: "applied", generation: 2 }, recoveryKey: RK, kit });
	const html = renderRegen(show);
	assert.ok(html.includes(RK));
	assert.match(html, /data-testid="emergency-kit"/);
	assert.match(html, /We show these once/);
	assert.match(html, /<button[^>]*disabled=""[^>]*>Done<\/button>/, "done waits for the acknowledgement");
	const done = renderRegen(regen({ type: "start", kind: "recovery_key", passkeys: 0 }, granted, { type: "submitted" }, { type: "result", rotation: { status: "applied", generation: 2 }, recoveryKey: RK, kit }, { type: "acknowledged", value: true }, { type: "finish" }));
	assert.ok(!done.includes(RK), "the key is gone after the learner confirmed");
	assert.match(done, /The new recovery key is saved\. The old one no longer works/);
});

test("regenerate: ten backup codes appear once; a waiting change shows when it runs", () => {
	const codes = regen({ type: "start", kind: "backup_codes", passkeys: 0 }, granted, { type: "submitted" }, { type: "result", rotation: { status: "pending", pendingAction: pending }, backupCodes: CODES });
	const html = renderRegen(codes);
	for (const c of CODES) assert.ok(html.includes(c), c);
	assert.match(html, /data-testid="regenerate-pending"/);
	assert.match(html, /The change is waiting\. The new secrets work from/);
	assert.match(html, /old ones still work/);
	for (const step of [regen(), regen({ type: "start", kind: "backup_codes", passkeys: 0 })]) assert.ok(!renderRegen(step).includes("BKUP-"), "no codes outside the show step");
});

test("regenerate: a failure is shown and the learner can start again; low backup codes warn", () => {
	const failed = regen({ type: "start", kind: "backup_codes", passkeys: 0 }, granted, { type: "submitted" }, { type: "failed", code: "rotation_pending" });
	assert.match(renderRegen(failed), /A key change is already waiting/);
	assert.match(renderRegen(failed), /Replace backup codes/);
	assert.match(renderRegen(regen(), 2), /You have 2 backup codes left/);
	assert.doesNotMatch(renderRegen(regen(), 8), /backup codes left/);
});

// ---------------------------------------------------------------- passkeys

function passkeysState(available: boolean, ...events: PasskeysEvent[]) {
	const s = reducePasskeys(initialPasskeys(), { type: "loaded", rows: [{ id: "a", name: "Laptop", signInOnly: false }, { id: "b", name: "Plain key", signInOnly: true }], availability: available ? { available: true } : { available: false, reason: "bridge_missing" }, reauthPasskeys: 2 });
	return events.reduce(reducePasskeys, s);
}
const renderPk = (s: ReturnType<typeof passkeysState>) => renderToString(<PasskeysView state={s} dispatch={noop} actions={{ continueAdd: noop }} reauthSlot={() => <div data-testid="reauth-stub" />} />);

test("passkeys: list with unlock and sign-in-only, add and remove offered on desktop", () => {
	const html = renderPk(passkeysState(true));
	assert.match(html, /Laptop/);
	assert.match(html, /Signs in and unlocks/);
	assert.match(html, /Signs in only/);
	assert.match(html, /Add a passkey/);
	assert.equal((html.match(/>Remove</g) ?? []).length, 2);
	assert.doesNotMatch(html, /passkeys-unavailable/);
});

test("passkeys: without the bridge the list stays, Add is replaced by the reason", () => {
	const html = renderPk(passkeysState(false));
	assert.doesNotMatch(html, /Add a passkey/);
	assert.match(html, /data-testid="passkeys-unavailable"/);
	assert.match(html, /Adding a passkey works in the LearnHarness desktop app/);
	assert.match(html, /Laptop/);
});

test("passkeys: the add flow asks for a name, then for re-authentication", () => {
	assert.match(renderPk(passkeysState(true, { type: "add_start" })), /Name for this passkey/);
	const reauth = renderPk(passkeysState(true, { type: "add_start" }, { type: "name_changed", name: "Phone" }, { type: "name_continue" }));
	assert.match(reauth, /data-testid="reauth-stub"/);
});

test("passkeys: removing says what it does for a key that unlocks and for one that only signs in", () => {
	assert.match(renderPk(passkeysState(true, { type: "remove_ask", id: "a" })), /Remove Laptop\?[\s\S]*changes your encryption keys/);
	assert.match(renderPk(passkeysState(true, { type: "remove_ask", id: "b" })), /only signs in/);
});

test("sign-in: the passkey button is off with the reason where the bridge is missing, and on in the desktop app", () => {
	const view = (passkey: Parameters<typeof SignInView>[0]["passkey"]) => renderToString(<SignInView state={initialSignIn("a@b.co")} dispatch={noop} actions={{ submitPassword: noop, passkey: noop, unlock: noop }} passkey={passkey} />);
	const off = view({ available: false, reason: "bridge_missing" });
	assert.match(off, /<button[^>]*disabled=""[^>]*>Sign in with a passkey<\/button>/);
	assert.match(off, /Passkeys work in the LearnHarness desktop app/);
	assert.match(view({ available: false, reason: "unsupported_server" }), /does not support passkeys in the desktop app/);
	assert.match(view(null), /Checking for passkey support/);
	const on = view({ available: true });
	assert.doesNotMatch(on, /<button[^>]*disabled=""[^>]*>Sign in with a passkey<\/button>/);
	assert.doesNotMatch(on, /passkey-unavailable/);
});
