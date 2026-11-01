// Account settings flows: the backup-codes-left warning (#12 style, at 3 or fewer), regenerating
// the recovery key or backup codes with re-authentication and one-time display, "Manage plan"
// (one-time link, hidden while billing is disabled in the beta), and changing the password.

import type { RotationDto } from "../contract.ts";
import type { AccountResponse, PendingAction } from "../deps.ts";
import { strings } from "../strings.ts";
import { newPasswordView, type BreachState, type NewPasswordView, type PasswordCheckResult } from "./password.ts";
import { initialReauth, reduceReauth, type ReauthEvent, type ReauthState } from "./reauth.ts";

export const BACKUP_CODES_WARN_AT = 3;

/** The passkey count to hand to `initialReauth`: zero where the ceremony cannot run, so the passkey method is not offered. */
export function reauthPasskeys(account: { passkeys: number; passkeyUsable?: boolean }): number {
	return account.passkeyUsable === false ? 0 : account.passkeys;
}

export interface BackupCodesWarning {
	show: boolean;
	text: string;
	advice: string;
	/** An empty list is more urgent than a short one. */
	severity: "warning" | "error";
}

export function backupCodesWarning(account: Pick<AccountResponse, "backupCodesLeft">): BackupCodesWarning {
	const n = account.backupCodesLeft;
	return { show: n <= BACKUP_CODES_WARN_AT, text: strings.account.backupCodesLow(n), advice: strings.account.backupCodesAdvice, severity: n === 0 ? "error" : "warning" };
}

/** "Manage plan" exists only when the server has billing enabled (hidden in the beta). */
export function managePlanVisible(account: Pick<AccountResponse, "billingEnabled">): boolean {
	return account.billingEnabled;
}

export interface ManagePlanState {
	status: "idle" | "working" | "failed";
	error?: string;
}

export type ManagePlanEvent = { type: "open" } | { type: "opened" } | { type: "failed"; code: string };

export function reduceManagePlan(s: ManagePlanState, e: ManagePlanEvent): ManagePlanState {
	switch (e.type) {
		case "open":
			return s.status === "working" ? s : { status: "working" };
		case "opened":
			return { status: "idle" };
		case "failed":
			return { status: "failed", error: e.code };
	}
}

// ---------------------------------------------------------------- regenerate recovery material

export type RegenerateKind = "recovery_key" | "backup_codes";

export type RegenerateState =
	| { step: "idle" }
	| { step: "reauth"; kind: RegenerateKind; reauth: ReauthState }
	| { step: "working"; kind: RegenerateKind }
	| { step: "show"; kind: RegenerateKind; recoveryKey?: string; backupCodes?: string[]; pending: PendingAction | null; acknowledged: boolean }
	| { step: "done"; kind: RegenerateKind; pending: PendingAction | null }
	| { step: "failed"; kind: RegenerateKind; error: string };

export type RegenerateEvent =
	| { type: "start"; kind: RegenerateKind; passkeys: number }
	| { type: "reauth"; event: ReauthEvent }
	| { type: "submitted" }
	| { type: "result"; rotation: RotationDto; recoveryKey?: string; backupCodes?: string[] }
	| { type: "acknowledged"; value: boolean }
	| { type: "finish" }
	| { type: "failed"; code: string }
	| { type: "cancel" };

export const initialRegenerate: RegenerateState = { step: "idle" };

export function reduceRegenerate(s: RegenerateState, e: RegenerateEvent): RegenerateState {
	if (e.type === "start") return { step: "reauth", kind: e.kind, reauth: initialReauth(e.passkeys) };
	if (e.type === "cancel") return s.step === "show" ? s : { step: "idle" };
	switch (s.step) {
		case "reauth":
			if (e.type === "reauth") return { ...s, reauth: reduceReauth(s.reauth, e.event) };
			if (e.type === "submitted" && s.reauth.step === "granted") return { step: "working", kind: s.kind };
			return s;
		case "working":
			if (e.type === "failed") return { step: "failed", kind: s.kind, error: e.code };
			if (e.type === "result")
				return {
					step: "show", kind: s.kind, pending: e.rotation.status === "pending" ? e.rotation.pendingAction : null, acknowledged: false,
					...(e.recoveryKey ? { recoveryKey: e.recoveryKey } : {}), ...(e.backupCodes ? { backupCodes: e.backupCodes } : {}),
				};
			return s;
		case "show":
			if (e.type === "acknowledged") return { ...s, acknowledged: e.value };
			if (e.type === "finish" && s.acknowledged) return { step: "done", kind: s.kind, pending: s.pending };
			return s;
		default:
			return s;
	}
}

/** The one-time secrets are visible only while the "show" step is open. */
export function regenerateSecrets(s: RegenerateState): { recoveryKey?: string; backupCodes?: string[] } | null {
	return s.step === "show" ? { ...(s.recoveryKey ? { recoveryKey: s.recoveryKey } : {}), ...(s.backupCodes ? { backupCodes: s.backupCodes } : {}) } : null;
}

// ---------------------------------------------------------------- change password

export type ChangePasswordState =
	| { step: "form"; password: string; confirm: string; breach: BreachState | null; busy: boolean; error?: string }
	| { step: "reauth"; password: string; reauth: ReauthState; submitted: boolean; error?: string }
	| { step: "done"; pending: boolean };

export type ChangePasswordEvent =
	| { type: "password_changed"; password: string }
	| { type: "confirm_changed"; confirm: string }
	| { type: "breach_result"; password: string; result: PasswordCheckResult }
	| { type: "continue" }
	| { type: "reauth"; event: ReauthEvent }
	| { type: "submitted" }
	| { type: "changed"; rotation: RotationDto }
	| { type: "failed"; code: string };

export function initialChangePassword(): ChangePasswordState {
	return { step: "form", password: "", confirm: "", breach: null, busy: false };
}

export function changePasswordView(s: Extract<ChangePasswordState, { step: "form" }>): NewPasswordView {
	return newPasswordView(s.password, s.confirm, s.breach, s.busy);
}

export function reduceChangePassword(s: ChangePasswordState, e: ChangePasswordEvent, passkeys = 0): ChangePasswordState {
	if (s.step === "done") return s;
	if (s.step === "form") {
		switch (e.type) {
			case "password_changed":
				return { ...s, password: e.password, error: undefined };
			case "confirm_changed":
				return { ...s, confirm: e.confirm };
			case "breach_result":
				return { ...s, breach: { forPassword: e.password, result: e.result } };
			case "continue":
				return changePasswordView(s).canSubmit ? { step: "reauth", password: s.password, reauth: initialReauth(passkeys), submitted: false } : s;
			default:
				return s;
		}
	}
	switch (e.type) {
		case "reauth":
			return { ...s, reauth: reduceReauth(s.reauth, e.event) };
		case "submitted":
			return s.reauth.step === "granted" ? { ...s, submitted: true } : s;
		case "changed":
			return { step: "done", pending: e.rotation.status === "pending" };
		case "failed":
			// a grant is single-use: after a failed action the learner confirms again
			return { ...s, submitted: false, reauth: initialReauth(passkeys), error: e.code };
		default:
			return s;
	}
}
