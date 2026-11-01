import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncState, SyncStatus } from "../src/core/vault/deps.ts";
import { backupCodesWarning, changePasswordView, initialChangePassword, initialRegenerate, managePlanVisible, reduceChangePassword, reduceManagePlan, reduceRegenerate, regenerateSecrets } from "../src/core/vault/models/account.ts";
import { deleteCallReady, emailMatches, initialDeleteAccount, reduceDeleteAccount, type DeleteAccountEvent, type DeleteAccountState } from "../src/core/vault/models/deleteAccount.ts";
import { exportReminder, initialExport, lastExportText, reduceExport } from "../src/core/vault/models/exportReminder.ts";
import { initialHistory, planGroups, reduceHistory, validRestoreTime, versionViews, type HistoryEvent, type HistoryState } from "../src/core/vault/models/history.ts";
import { syncBanner } from "../src/core/vault/models/syncStatus.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

function status(state: SyncState, over: Partial<SyncStatus> = {}): SyncStatus {
	return { state, pendingChanges: 0, lastSuccess: "2026-11-01T11:55:00Z", conflicts: 0, rollbacks: 0, rejected: 0, ...over };
}

test("sync banner has text for every SyncState", () => {
	const all: SyncState[] = ["idle", "syncing", "offline", "error", "over_quota", "read_only", "rotation_rejected", "revoked", "needs_unlock"];
	for (const st of all) {
		const b = syncBanner(status(st), { now: NOW, billingEnabled: true });
		assert.ok(b.title.length > 0, st);
		assert.ok(b.facts.length > 0, st);
	}
});

test("sync banner: idle is a quiet line with the last sync", () => {
	const b = syncBanner(status("idle"), { now: NOW, billingEnabled: false });
	assert.equal(b.level, "line");
	assert.equal(b.title, "Synced 5 minutes ago");
});

test("sync banner: pending changes and conflicts appear as facts", () => {
	const b = syncBanner(status("offline", { pendingChanges: 3, conflicts: 1 }), { now: NOW, billingEnabled: false });
	assert.equal(b.level, "banner");
	assert.deepEqual(b.facts, ["3 changes waiting to sync", "Last sync 5 minutes ago", "1 conflict kept both versions"]);
	assert.equal(syncBanner(status("idle", { pendingChanges: 1 }), { now: NOW, billingEnabled: false }).facts[0], "1 change waiting to sync");
});

test("sync banner: never synced", () => {
	const b = syncBanner(status("idle", { lastSuccess: null }), { now: NOW, billingEnabled: false });
	assert.equal(b.title, "Not synced yet");
	assert.ok(b.facts.includes("Never synced"));
});

test("sync banner: actions per state; plan link only with billing", () => {
	assert.equal(syncBanner(status("needs_unlock"), { now: NOW, billingEnabled: false }).action, "unlock");
	assert.equal(syncBanner(status("revoked"), { now: NOW, billingEnabled: false }).action, "sign_in");
	assert.equal(syncBanner(status("rotation_rejected"), { now: NOW, billingEnabled: false }).action, "sign_in");
	assert.equal(syncBanner(status("over_quota"), { now: NOW, billingEnabled: true }).action, "manage_plan");
	assert.equal(syncBanner(status("over_quota"), { now: NOW, billingEnabled: false }).action, null);
	assert.equal(syncBanner(status("read_only"), { now: NOW, billingEnabled: true }).blocked, true);
	assert.equal(syncBanner(status("offline"), { now: NOW, billingEnabled: true }).blocked, false);
	assert.match(syncBanner(status("error", { error: "boom" }), { now: NOW, billingEnabled: false }).body, /boom/);
});

// ---------------------------------------------------------------- history

function hrun(s: HistoryState, ...e: HistoryEvent[]): HistoryState {
	return e.reduce(reduceHistory, s);
}

const versions = [
	{ seq: 9, createdAt: "2026-10-30T10:00:00Z", deviceName: "Laptop", deleted: false, size: 2048 },
	{ seq: 5, createdAt: "2026-10-20T10:00:00Z", deviceName: "Phone", deleted: true, size: 0 },
];

test("history: session versions, confirm, restore", () => {
	let s = hrun(initialHistory(), { type: "path_changed", path: "notes/a.md" }, { type: "load_versions" });
	assert.equal(s.doc.busy, true);
	s = hrun(s, { type: "versions_loaded", versions });
	const v = versionViews(versions);
	assert.equal(v[0]?.size, "2.0 KB");
	assert.equal(v[1]?.size, "Deleted");
	assert.match(v[0]?.line ?? "", /2026-10-30 10:00 UTC, on Laptop/);
	assert.equal(hrun(s, { type: "ask_restore_version", seq: 123 }).doc.confirmSeq, null, "unknown version ignored");
	s = hrun(s, { type: "ask_restore_version", seq: 5 }, { type: "restore_version" });
	assert.equal(s.doc.busy, true);
	s = hrun(s, { type: "version_restored" });
	assert.equal(s.restoredDoc, "notes/a.md");
	assert.equal(s.doc.confirmSeq, null);
});

test("history: whole-vault preview lists changed, added, removed, then needs a confirmation", () => {
	const plan = [
		{ path: "a.md", change: "changed" as const },
		{ path: "b.md", change: "added" as const },
		{ path: "c.md", change: "removed" as const },
		{ path: "d.md", change: "changed" as const },
	];
	let s = hrun(initialHistory(), { type: "at_changed", at: "2026-10-20T10:00" }, { type: "preview" });
	assert.equal(s.vault.busy, true);
	s = hrun(s, { type: "previewed", plan });
	const g = planGroups(plan);
	assert.deepEqual([g.changed.length, g.added.length, g.removed.length], [2, 1, 1]);
	assert.equal(g.summary, "2 will change, 1 will be added back, 1 will be removed.");
	assert.equal(hrun(s, { type: "restore_all" }).vault.busy, false, "cannot restore without confirming");
	s = hrun(s, { type: "ask_restore_all" }, { type: "restore_all" });
	assert.equal(s.vault.busy, true);
	s = hrun(s, { type: "all_restored", plan });
	assert.equal(s.vault.restored, 4);
	assert.equal(s.vault.plan, null);
});

test("history: an empty preview offers nothing to confirm", () => {
	const s = hrun(initialHistory(), { type: "at_changed", at: "x" }, { type: "previewed", plan: [] });
	assert.equal(planGroups([]).empty, true);
	assert.equal(hrun(s, { type: "ask_restore_all" }).vault.confirming, false);
});

test("history: restore time must be in the past and inside the window", () => {
	assert.equal(validRestoreTime("2026-10-20T10:00:00Z", NOW, 90), true);
	assert.equal(validRestoreTime("2026-12-01T10:00:00Z", NOW, 90), false);
	assert.equal(validRestoreTime("2025-01-01T10:00:00Z", NOW, 90), false);
	assert.equal(validRestoreTime("garbage", NOW, 90), false);
});

// ---------------------------------------------------------------- export reminder

test("export reminder: shows after more than 90 days, not at 90", () => {
	const s = initialExport();
	assert.equal(exportReminder({ lastExportAt: "2026-08-03T12:00:00Z", createdAt: "2026-01-01T00:00:00Z" }, s, NOW).show, false); // 90 days
	const r = exportReminder({ lastExportAt: "2026-08-02T11:00:00Z", createdAt: "2026-01-01T00:00:00Z" }, s, NOW); // 91 days
	assert.equal(r.show, true);
	assert.equal(r.days, 91);
	assert.equal(r.body, "Your last export is 91 days old.");
});

test("export reminder: never exported counts from the account creation", () => {
	assert.equal(exportReminder({ lastExportAt: null, createdAt: "2026-10-01T00:00:00Z" }, initialExport(), NOW).show, false);
	const r = exportReminder({ lastExportAt: null, createdAt: "2026-05-01T00:00:00Z" }, initialExport(), NOW);
	assert.equal(r.show, true);
	assert.equal(r.never, true);
	assert.equal(r.body, "You have never downloaded an export.");
});

test("export reminder: dismissable, switchable off, and an export clears it", () => {
	const old = { lastExportAt: "2026-01-01T00:00:00Z", createdAt: "2025-01-01T00:00:00Z" };
	assert.equal(exportReminder(old, reduceExport(initialExport(), { type: "dismiss" }), NOW).show, false);
	assert.equal(exportReminder(old, reduceExport(initialExport(), { type: "reminder_setting", enabled: false }), NOW).show, false);
	assert.equal(exportReminder(old, reduceExport(initialExport(), { type: "downloaded" }), NOW).show, false);
	assert.equal(reduceExport(initialExport(), { type: "failed", code: "network" }).status, "failed");
	assert.equal(lastExportText({ lastExportAt: null }, NOW), "You have not exported yet.");
	assert.equal(lastExportText({ lastExportAt: "2026-10-30T12:00:00Z" }, NOW), "Last export 2 days ago");
});

// ---------------------------------------------------------------- account

test("backup codes warning at 3 or fewer", () => {
	assert.equal(backupCodesWarning({ backupCodesLeft: 4 }).show, false);
	const w3 = backupCodesWarning({ backupCodesLeft: 3 });
	assert.equal(w3.show, true);
	assert.equal(w3.text, "You have 3 backup codes left.");
	assert.equal(backupCodesWarning({ backupCodesLeft: 1 }).text, "You have 1 backup code left.");
	const w0 = backupCodesWarning({ backupCodesLeft: 0 });
	assert.equal(w0.severity, "error");
	assert.equal(w0.text, "You have no backup codes left.");
});

test("manage plan is hidden while billing is disabled", () => {
	assert.equal(managePlanVisible({ billingEnabled: false }), false);
	assert.equal(managePlanVisible({ billingEnabled: true }), true);
	let s = reduceManagePlan({ status: "idle" }, { type: "open" });
	assert.equal(s.status, "working");
	s = reduceManagePlan(s, { type: "failed", code: "billing_disabled" });
	assert.deepEqual(s, { status: "failed", error: "billing_disabled" });
});

test("regenerate backup codes: re-authenticate, show once, pending is reported", () => {
	let s = reduceRegenerate(initialRegenerate, { type: "start", kind: "backup_codes", passkeys: 0 });
	assert.equal(s.step, "reauth");
	assert.equal(regenerateSecrets(s), null);
	s = reduceRegenerate(s, { type: "reauth", event: { type: "granted", reauthId: "h", strength: "password", now: 1 } });
	s = reduceRegenerate(s, { type: "submitted" });
	assert.equal(s.step, "working");
	s = reduceRegenerate(s, {
		type: "result", backupCodes: ["A", "B"],
		rotation: { status: "pending", pendingAction: { id: "p", kind: "regenerate_backup_codes", strength: "password", requestedBy: "d", requestedByName: "n", targetDeviceId: null, runsAt: "x", createdAt: "x", cancellable: true } },
	});
	assert.deepEqual(regenerateSecrets(s), { backupCodes: ["A", "B"] });
	assert.equal(s.step === "show" && s.pending?.id, "p");
	assert.equal(reduceRegenerate(s, { type: "finish" }).step, "show", "needs acknowledgement");
	assert.equal(reduceRegenerate(s, { type: "cancel" }).step, "show", "cannot dismiss unseen secrets by accident");
	s = reduceRegenerate(reduceRegenerate(s, { type: "acknowledged", value: true }), { type: "finish" });
	assert.equal(s.step, "done");
	assert.equal(regenerateSecrets(s), null);
});

test("change password: rules, then re-authentication, then done", () => {
	const pw = "another-long-password";
	let s = reduceChangePassword(initialChangePassword(), { type: "password_changed", password: pw });
	s = reduceChangePassword(s, { type: "confirm_changed", confirm: pw });
	s = reduceChangePassword(s, { type: "breach_result", password: pw, result: { ok: true, onlineChecked: true } });
	assert.equal(s.step === "form" && changePasswordView(s).canSubmit, true);
	s = reduceChangePassword(s, { type: "continue" });
	assert.equal(s.step, "reauth");
	s = reduceChangePassword(s, { type: "reauth", event: { type: "granted", reauthId: "h", strength: "password", now: 1 } });
	s = reduceChangePassword(s, { type: "submitted" });
	s = reduceChangePassword(s, { type: "failed", code: "reauth_required" });
	assert.equal(s.step === "reauth" && s.reauth.step, "form", "grant is used up");
	s = reduceChangePassword(s, { type: "changed", rotation: { status: "applied", generation: 2 } });
	assert.deepEqual(s, { step: "done", pending: false });
});

// ---------------------------------------------------------------- delete account

const EMAIL = "Learner@Example.org";

function drun(s: DeleteAccountState, ...e: DeleteAccountEvent[]): DeleteAccountState {
	return e.reduce((acc, ev) => reduceDeleteAccount(acc, ev, EMAIL), s);
}

test("delete account: export offered first, then email, then re-auth, then delete", () => {
	let s = drun(initialDeleteAccount, { type: "export_start" });
	assert.equal(s.step === "export" && s.busy, true);
	s = drun(s, { type: "export_done" });
	assert.equal(s.step === "export" && s.exported, true);
	s = drun(s, { type: "continue" });
	assert.equal(s.step, "email");
	assert.equal(drun(s, { type: "typed_changed", typed: "wrong@example.org" }, { type: "continue" }).step, "email");
	s = drun(s, { type: "typed_changed", typed: "  learner@example.org " }, { type: "continue" });
	assert.equal(s.step, "reauth");
	assert.equal(deleteCallReady(s), null);
	s = drun(s, { type: "reauth", event: { type: "granted", reauthId: "h", strength: "password", now: 1 } });
	assert.equal(deleteCallReady(s), "h");
	s = drun(s, { type: "submitted" });
	assert.equal(deleteCallReady(s), null);
	assert.equal(drun(s, { type: "deleted" }).step, "done");
});

test("delete account: skipping the export is an explicit continue; a failure resets the grant", () => {
	let s = drun(initialDeleteAccount, { type: "continue" });
	assert.equal(s.step === "email" && s.exported, false);
	s = drun(s, { type: "typed_changed", typed: EMAIL }, { type: "continue" }, { type: "reauth", event: { type: "granted", reauthId: "h", strength: "password", now: 1 } }, { type: "submitted" }, { type: "failed", code: "reauth_required" });
	assert.equal(s.step === "reauth" && s.reauth.step, "form");
	assert.equal(emailMatches("", ""), false);
});
