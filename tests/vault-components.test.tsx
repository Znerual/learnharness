import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { qrMatrix, qrPath } from "../components/vault/qr.ts";
import type { DeviceRow, SyncStatus } from "../src/core/vault/deps.ts";
import { initialApprover, initialJoiner, type ApproverState } from "../src/core/vault/models/pairing.ts";
import { initialDevices, reduceDevices } from "../src/core/vault/models/devices.ts";
import { initialExport, reduceExport } from "../src/core/vault/models/exportReminder.ts";
import { initialHistory, reduceHistory } from "../src/core/vault/models/history.ts";
import { initialSignIn, reduceSignIn } from "../src/core/vault/models/signin.ts";
import { initialSignup, reduceSignup, type SignupMaterial, type SignupState } from "../src/core/vault/models/signup.ts";
import { initialDeleteAccount, reduceDeleteAccount } from "../src/core/vault/models/deleteAccount.ts";
import { initialRecover } from "../src/core/vault/models/recover.ts";
import { initialUnlock, reduceUnlock } from "../src/core/vault/models/unlock.ts";
import { strings } from "../src/core/vault/strings.ts";
import { BackupCodesWarning, ManagePlanView } from "../components/vault/AccountNotices.tsx";
import { DeleteAccountView } from "../components/vault/DeleteAccount.tsx";
import { DevicesView } from "../components/vault/Devices.tsx";
import { EmergencyKit } from "../components/vault/EmergencyKit.tsx";
import { ExportReminderView, ExportSettingsView } from "../components/vault/ExportReminder.tsx";
import { DocumentPickerView, HistoryView } from "../components/vault/History.tsx";
import { PairingApproverView, PairingJoinerView } from "../components/vault/Pairing.tsx";
import { RecoverView } from "../components/vault/Recover.tsx";
import { SignInView } from "../components/vault/SignIn.tsx";
import { SignUpView } from "../components/vault/SignUp.tsx";
import { SyncStatusBannerView } from "../components/vault/SyncStatusBanner.tsx";
import { UnlockView } from "../components/vault/Unlock.tsx";

const noop = () => undefined;
const NOW = new Date("2026-11-01T12:00:00Z");
const RK = "QWER-TYUI-OPAS-DFGH-JKLZ";
const CODES = Array.from({ length: 10 }, (_, i) => `BKUP-${1000 + i}`);
const material: SignupMaterial = {
	recoveryKey: RK,
	backupCodes: CODES,
	kit: { email: "learner@example.org", serverUrl: "https://vault.example.org", recoveryKey: RK, recoveryKeyQr: `lhv1-recovery:https://vault.example.org:learner%40example.org:${RK}`, createdAt: "2026-11-01T10:00:00Z" },
};
const signupActions = { sendCode: noop, resendCode: noop, verify: noop, createAccount: noop, confirm: noop };

function signupAt(step: SignupState["step"]): SignupState {
	const email = "learner@example.org";
	switch (step) {
		case "email":
			return initialSignup(email);
		case "code":
			return { step: "code", email, code: "", busy: false };
		case "password":
			return { step: "password", email, password: "", confirm: "", breach: null, busy: false };
		case "secrets":
			return { step: "secrets", email, material, acknowledged: false, busy: false };
		case "kit":
			return { step: "kit", email, material, kitOpened: false, busy: false };
		case "confirm":
			return { step: "confirm", email, material, typed: "", attempts: 0, busy: false };
		case "done":
			return { step: "done", email, busy: false };
	}
}

function renderSignup(step: SignupState["step"]): string {
	return renderToString(<SignUpView state={signupAt(step)} dispatch={noop} actions={signupActions} />);
}

test("sign-up: the recovery key and every backup code appear on the secrets step", () => {
	const html = renderSignup("secrets");
	assert.ok(html.includes(RK));
	for (const c of CODES) assert.ok(html.includes(c), c);
	assert.match(html, /we show them only once/);
	assert.match(html, /data-testid="recovery-key"/);
	assert.match(html, /data-testid="backup-codes"/);
});

test("sign-up: the kit step shows the printable kit with the key, as text and QR code", () => {
	const html = renderSignup("kit");
	assert.ok(html.includes(RK));
	assert.match(html, /<svg/);
	assert.match(html, /emergency kit/i);
	assert.match(html, /Print or save as PDF/);
	assert.doesNotMatch(html, /BKUP-/, "backup codes are not part of the kit");
});

test("sign-up: no secret appears on any other step, even though the state still holds them", () => {
	for (const step of ["email", "code", "password", "confirm", "done"] as const) {
		const html = renderSignup(step);
		assert.ok(!html.includes(RK), `${step} leaks the recovery key`);
		assert.ok(!html.includes("BKUP-"), `${step} leaks a backup code`);
		assert.ok(!html.includes("data-secret"), `${step} renders a secret block`);
	}
});

test("sign-up: key strings per step", () => {
	assert.match(renderSignup("email"), /Email address/);
	assert.match(renderSignup("code"), /8-character code to learner@example.org/);
	assert.match(renderSignup("password"), /At least 12 characters/);
	assert.match(renderSignup("confirm"), /last 4 characters of your recovery key/);
	assert.match(renderSignup("done"), /Your vault is ready/);
});

test("sign-up: continue on the secrets step is disabled until acknowledged", () => {
	assert.match(renderSignup("secrets"), /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
	const acked = reduceSignup(signupAt("secrets"), { type: "acknowledged", value: true });
	const html = renderToString(<SignUpView state={acked} dispatch={noop} actions={signupActions} />);
	assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
});

test("emergency kit: email, server, recovery key and a QR code", () => {
	const html = renderToString(<EmergencyKit kit={material.kit} />);
	assert.match(html, /learner@example.org/);
	assert.match(html, /https:\/\/vault.example.org/);
	assert.ok(html.includes(RK));
	assert.match(html, /<svg[^>]*role="img"/);
	assert.match(html, /@media print/);
});

test("qr: deterministic matrix with a quiet-zone SVG path", () => {
	const m = qrMatrix("lhv1-pair:https://v:id:secret");
	assert.equal(m.modules.length, m.size * m.size);
	assert.ok(m.size >= 21);
	assert.deepEqual(qrMatrix("abc"), qrMatrix("abc"));
	const path = qrPath(m);
	assert.match(path, /^M\d+ \d+h\d+v1h-\d+z/);
	// finder pattern: the top-left module is dark
	assert.equal(m.modules[0], true);
});

test("sign-in: form and the needs-unlock path with its three choices", () => {
	const form = renderToString(<SignInView state={initialSignIn()} dispatch={noop} actions={{ submitPassword: noop, passkey: noop, unlock: noop }} />);
	assert.match(form, /Sign in with a passkey/);
	assert.match(form, /I lost my password/);
	const locked = reduceSignIn(initialSignIn("a@b.co"), { type: "session", session: { state: "needs_unlock", email: "a@b.co" } });
	const html = renderToString(<SignInView state={locked} dispatch={noop} actions={{ submitPassword: noop, passkey: noop, unlock: noop }} />);
	assert.match(html, /signed in, but this device cannot unlock/);
	assert.match(html, /Approve from another signed-in device/);
	assert.match(html, /Use my recovery key or a backup code/);
	assert.match(html, /Unlock with my password/);
});

test("unlock: expired session and offline notice", () => {
	const expired = renderToString(<UnlockView state={reduceUnlock(initialUnlock, { type: "failed", code: "signed_out" })} onAction={noop} />);
	assert.match(expired, /This device must sign in again/);
	assert.match(expired, /Sign in again/);
	const offline = renderToString(<UnlockView state={reduceUnlock(initialUnlock, { type: "session", session: { state: "signed_in", accountId: "a", deviceId: "d", ephemeral: false, offline: true } })} onAction={noop} />);
	assert.match(offline, /Unlocked offline/);
	assert.equal(renderToString(<UnlockView state={{ step: "ready", offline: false }} onAction={noop} />), "", "a normal launch shows nothing");
});

test("recover: form, and the forced new password", () => {
	assert.match(renderToString(<RecoverView state={initialRecover()} dispatch={noop} onSubmitSecret={noop} onSubmitPassword={noop} />), /Recovery key or backup code/);
	const html = renderToString(<RecoverView state={initialRecover("new_password")} dispatch={noop} onSubmitSecret={noop} onSubmitPassword={noop} />);
	assert.match(html, /Sync stays off until you set a new password/);
	assert.match(html, /data-testid="password-rules"/);
});

const dev = (o: Partial<DeviceRow>): DeviceRow => ({ id: "x", lhDeviceId: "dev_x", name: "Device", ephemeral: false, keysProtected: true, createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-11-01T11:00:00Z", current: false, established: true, hasUnlockMethod: true, ...o });

test("devices: badges and the two different actions", () => {
	const s = reduceDevices(initialDevices(), {
		type: "loaded",
		devices: [dev({ id: "me", name: "This laptop", current: true }), dev({ id: "k", name: "Kiosk", ephemeral: true, keysProtected: false, established: false })],
		pending: null,
	});
	const html = renderToString(<DevicesView state={s} dispatch={noop} now={NOW} actions={{ renameSubmit: noop, signOut: noop, confirmPending: noop, cancelPending: noop, addDevice: noop }} />);
	assert.match(html, /This device/);
	assert.match(html, /Keys not protected/);
	assert.match(html, /Session only/);
	assert.match(html, /Sign out this device/);
	assert.match(html, /Revoke lost device/);
	assert.match(html, /Last seen 1 hour ago/);
	assert.doesNotMatch(html, /pending-action/);
});

test("devices: the pending revocation shows confirm only to an established device", () => {
	const pending = { id: "p", kind: "revoke_device" as const, strength: "password" as const, requestedBy: "other", requestedByName: "Work PC", targetDeviceId: "k", runsAt: "2026-11-02T12:00:00Z", createdAt: "2026-11-01T12:00:00Z", cancellable: true };
	const mk = (established: boolean) =>
		renderToString(
			<DevicesView
				state={reduceDevices(initialDevices(), { type: "loaded", devices: [dev({ id: "me", current: true, established }), dev({ id: "k", name: "Kiosk" })], pending })}
				dispatch={noop}
				now={NOW}
				actions={{ renameSubmit: noop, signOut: noop, confirmPending: noop, cancelPending: noop, addDevice: noop }}
			/>,
		);
	assert.match(mk(true), /Confirm now/);
	assert.match(mk(true), /Revoke Kiosk/);
	assert.doesNotMatch(mk(false), /Confirm now/);
	assert.match(mk(false), /more than 24 hours before the request/);
});

test("pairing approver: the QR and text code while waiting, name and code before approving", () => {
	const showing: ApproverState = { step: "showing", pairingId: "p", qr: "lhv1-pair:https://v:p:abc", text: "ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWX", busy: false };
	const html = renderToString(<PairingApproverView state={showing} dispatch={noop} onStart={noop} onApprove={noop} />);
	assert.match(html, /<svg/);
	assert.match(html, /ABCD EFGH JKMN/);
	assert.match(html, /Waiting for the new device/);
	const review = renderToString(<PairingApproverView state={{ step: "review", pairingId: "p", deviceName: "Anna's phone", code: "042517", busy: false }} dispatch={noop} onStart={noop} onApprove={noop} />);
	assert.match(review, /Anna&#x27;s phone/);
	assert.match(review, /042 517/);
	assert.match(review, /The codes match, approve/);
	assert.match(review, /They do not match, cancel/);
	assert.doesNotMatch(review, /<svg/, "no secret QR after the join");
	assert.match(renderToString(<PairingApproverView state={initialApprover} dispatch={noop} onStart={noop} onApprove={noop} />), /Add a device/);
});

test("pairing joiner shows the same 6-digit code", () => {
	const html = renderToString(<PairingJoinerView state={{ step: "showing", pairingId: "p", qr: "lhv1-pair:x", text: "A".repeat(52), code: "042517", busy: false }} dispatch={noop} onShow={noop} onJoin={noop} />);
	assert.match(html, /042 517/);
	assert.match(html, /<svg/);
	assert.match(renderToString(<PairingJoinerView state={{ step: "waiting", pairingId: "p", code: "042517", busy: true }} dispatch={noop} onShow={noop} onJoin={noop} />), /042 517/);
	assert.match(renderToString(<PairingJoinerView state={initialJoiner} dispatch={noop} onShow={noop} onJoin={noop} />), /Add this device/);
});

test("sync banner: user-facing text for the states", () => {
	const st = (state: SyncStatus["state"], o: Partial<SyncStatus> = {}): SyncStatus => ({ state, pendingChanges: 0, lastSuccess: "2026-11-01T11:00:00Z", conflicts: 0, rollbacks: 0, rejected: 0, ...o });
	const r = (s: SyncStatus, billing = false) => renderToString(<SyncStatusBannerView status={s} now={NOW} billingEnabled={billing} />);
	assert.match(r(st("idle")), /Synced 1 hour ago/);
	assert.match(r(st("syncing", { pendingChanges: 2 })), /Syncing\.\.\./);
	assert.match(r(st("offline", { pendingChanges: 4 })), /Your changes are saved on this device/);
	assert.match(r(st("offline", { pendingChanges: 4 })), /4 changes waiting to sync/);
	assert.match(r(st("over_quota"), true), /Your vault is full/);
	assert.match(r(st("over_quota"), true), /Manage plan/);
	assert.doesNotMatch(r(st("over_quota"), false), /Manage plan/);
	assert.match(r(st("read_only")), /read-only/);
	assert.match(r(st("rotation_rejected")), /Sync paused for safety/);
	assert.match(r(st("revoked")), /This device was removed/);
	assert.match(r(st("needs_unlock")), /Unlock to keep syncing/);
	assert.match(r(st("error")), /Sync problem/);
	assert.match(r(st("idle", { rejected: 2 })), /2 changes were rejected/);
	assert.match(r(st("error", { rejected: 1 })), /1 change was rejected/);
	assert.doesNotMatch(r(st("idle")), /rejected/);
});

test("history: versions, preview groups and the confirmation", () => {
	let s = initialHistory();
	s = reduceHistory(s, { type: "path_changed", path: "notes/a.md" });
	s = reduceHistory(reduceHistory(s, { type: "load_versions" }), { type: "versions_loaded", versions: [{ seq: 4, createdAt: "2026-10-30T10:00:00Z", deviceName: "Laptop", deleted: false, size: 1024 }] });
	s = reduceHistory(s, { type: "at_changed", at: "2026-10-20T10:00" });
	s = reduceHistory(reduceHistory(s, { type: "preview" }), {
		type: "previewed",
		plan: [
			{ path: "a.md", change: "changed" },
			{ path: "b.md", change: "added" },
			{ path: "c.md", change: "removed" },
		],
	});
	s = reduceHistory(s, { type: "ask_restore_all" });
	const html = renderToString(<HistoryView state={s} dispatch={noop} now={NOW} docTitle="My notes" actions={{ chooseDocument: noop, loadVersions: noop, restoreVersion: noop, preview: noop, restoreAll: noop }} />);
	assert.match(html, /My notes/);
	assert.match(html, /Choose another document/);
	assert.doesNotMatch(html, /<input[^>]*value="notes\/a.md"/, "no path to type");
	assert.match(html, /kept for up to 90 days/);
	assert.match(html, /2026-10-30 10:00 UTC, on Laptop/);
	assert.match(html, /1 will change, 1 will be added back, 1 will be removed/);
	assert.match(html, /data-group="added"/);
	assert.match(html, /Restore 3 documents\? The current versions stay in history/);
});

test("history: nothing chosen yet offers the document picker, which searches titles and paths", () => {
	const html = renderToString(<HistoryView state={initialHistory()} dispatch={noop} now={NOW} actions={{ chooseDocument: noop, loadVersions: noop, restoreVersion: noop, preview: noop, restoreAll: noop }} />);
	assert.match(html, /No document chosen yet/);
	assert.match(html, />Choose a document</);
	const docs = [
		{ path: "chats/chat_a.json", kind: "chat" as const, title: "Machine learning basics", updatedAt: "2026-10-30T10:00:00Z" },
		{ path: "jobs/job_b.json", kind: "job" as const, title: 'research for "Machine learning basics"', updatedAt: "2026-10-29T10:00:00Z" },
		{ path: "notes/todo.md", kind: "other" as const, title: "notes/todo.md", updatedAt: null },
	];
	const picker = (q: string, d: typeof docs | null = docs) => renderToString(<DocumentPickerView documents={d} query={q} onQuery={noop} onPick={noop} onClose={noop} />);
	assert.match(picker(""), /role="dialog"/);
	assert.equal((picker("").match(/data-testid="document-option"/g) ?? []).length, 3);
	assert.equal((picker("research LEARNING").match(/data-testid="document-option"/g) ?? []).length, 1);
	assert.equal((picker("todo").match(/data-testid="document-option"/g) ?? []).length, 1, "the path is searched too");
	assert.match(picker("zzz"), /No document matches/);
	assert.match(picker("", []), /There are no documents yet/);
	assert.match(picker("", null), /Loading your documents/);
	assert.match(picker(""), /Background job/);
});

const oldAccount = { lastExportAt: "2026-06-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };

test("export reminder: banner when old, nothing when recent, dismissed or switched off", () => {
	const view = (acc: typeof oldAccount, st = initialExport()) => renderToString(<ExportReminderView account={acc} state={st} now={NOW} dispatch={noop} onDownload={noop} onTurnOff={noop} />);
	const html = view(oldAccount);
	assert.match(html, /Download a backup of your vault/);
	assert.match(html, /Your last export is 153 days old/);
	assert.match(html, /Remind me later/);
	assert.match(html, /Do not remind me/);
	assert.equal(view({ ...oldAccount, lastExportAt: "2026-10-20T00:00:00Z" }), "");
	assert.equal(view(oldAccount, reduceExport(initialExport(), { type: "dismiss" })), "");
	assert.equal(view(oldAccount, reduceExport(initialExport(), { type: "reminder_setting", enabled: false })), "");
	assert.match(renderToString(<ExportSettingsView account={oldAccount} state={initialExport()} now={NOW} onDownload={noop} onSetting={noop} />), /Remind me to export every 90 days/);
});

test("backup codes warning and manage plan", () => {
	assert.match(renderToString(<BackupCodesWarning account={{ backupCodesLeft: 2 }} onReplace={noop} />), /You have 2 backup codes left/);
	assert.equal(renderToString(<BackupCodesWarning account={{ backupCodesLeft: 8 }} onReplace={noop} />), "");
	assert.equal(renderToString(<ManagePlanView account={{ billingEnabled: false }} status="idle" onOpen={noop} />), "", "hidden in the beta");
	assert.match(renderToString(<ManagePlanView account={{ billingEnabled: true }} status="idle" onOpen={noop} />), /Manage plan/);
});

test("delete account: export first, then email, then re-authentication", () => {
	const email = "learner@example.org";
	const props = { email, dispatch: noop, actions: { exportFirst: noop } };
	const first = renderToString(<DeleteAccountView state={initialDeleteAccount} {...props} />);
	assert.match(first, /Download an export first/);
	assert.match(first, /permanently deletes your account/);
	assert.match(first, /I do not need an export/);
	const emailStep = renderToString(<DeleteAccountView state={reduceDeleteAccount(initialDeleteAccount, { type: "continue" }, email)} {...props} />);
	assert.match(emailStep, /Type learner@example.org to confirm/);
	assert.match(emailStep, /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
	let s = reduceDeleteAccount(initialDeleteAccount, { type: "continue" }, email);
	s = reduceDeleteAccount(reduceDeleteAccount(s, { type: "typed_changed", typed: email }, email), { type: "continue" }, email);
	const reauth = renderToString(<DeleteAccountView state={s} {...props} reauthSlot={() => <p>REAUTH FORM</p>} />);
	assert.match(reauth, /confirm it is you/);
	assert.match(reauth, /REAUTH FORM/);
});

test("every user-facing string comes from strings.ts: spot-check wording rules", () => {
	// plain wording: no exclamation marks, no emoji, no "oops"
	const flat = JSON.stringify(strings, (_k, v) => (typeof v === "function" ? v(1, 2, 3) : v));
	assert.doesNotMatch(flat, /!|oops|whoops/i);
	assert.doesNotMatch(flat, /\p{Extended_Pictographic}/u);
});
