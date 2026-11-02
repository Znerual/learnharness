// Live password rule feedback (ADR 0004). Length is checked locally on every keystroke. The
// breach and common-password check runs on the server through the client's `checkPassword`
// (route passwordCheck), so the result arrives asynchronously and belongs to one password.

import { strings } from "../strings.ts";

export const MIN_PASSWORD_LENGTH = 12;

/** Result of the server-side check, same shape as the client's PasswordCheck. */
export type PasswordCheckResult =
	| { ok: true; onlineChecked: boolean }
	| { ok: false; reason: "too_short" | "common" | "breached"; breachCount?: number };

export interface BreachState {
	/** The password the result belongs to; a stale result never counts. */
	forPassword: string;
	result: PasswordCheckResult;
}

export type RuleStatus = "ok" | "fail" | "pending" | "neutral";

export interface PasswordRule {
	id: "length" | "not_common" | "not_breached";
	label: string;
	status: RuleStatus;
	detail?: string;
}

export interface PasswordFeedback {
	rules: PasswordRule[];
	/** True when the password may be submitted. */
	acceptable: boolean;
	/** True when the screen should ask the server for a breach check (length ok, no fresh result). */
	needsCheck: boolean;
}

export function passwordLength(p: string): number {
	return [...p].length;
}

export function passwordFeedback(password: string, breach: BreachState | null): PasswordFeedback {
	const lengthOk = passwordLength(password) >= MIN_PASSWORD_LENGTH;
	const fresh = breach && breach.forPassword === password ? breach.result : null;
	const rules: PasswordRule[] = [{ id: "length", label: strings.password.ruleLength, status: password === "" ? "neutral" : lengthOk ? "ok" : "fail" }];
	let common: RuleStatus = "neutral";
	let breached: RuleStatus = "neutral";
	let breachedDetail: string | undefined;
	if (lengthOk) {
		if (!fresh) {
			common = "pending";
			breached = "pending";
			breachedDetail = strings.password.breachedPending;
		} else if (fresh.ok) {
			common = "ok";
			breached = fresh.onlineChecked ? "ok" : "neutral";
			if (!fresh.onlineChecked) breachedDetail = strings.password.breachedSkipped;
		} else if (fresh.reason === "common") {
			common = "fail";
		} else if (fresh.reason === "breached") {
			common = "ok";
			breached = "fail";
			breachedDetail = strings.password.breachedFound(fresh.breachCount);
		}
	}
	rules.push({ id: "not_common", label: strings.password.ruleNotCommon, status: common });
	rules.push({ id: "not_breached", label: strings.password.ruleNotBreached, status: breached, ...(breachedDetail ? { detail: breachedDetail } : {}) });
	return { rules, acceptable: lengthOk && !!fresh && fresh.ok, needsCheck: lengthOk && !fresh };
}

export interface NewPasswordView {
	feedback: PasswordFeedback;
	mismatch: boolean;
	canSubmit: boolean;
}

/** Rules plus the repeat field, shared by sign-up, recovery and change-password screens. */
export function newPasswordView(password: string, confirm: string, breach: BreachState | null, busy: boolean): NewPasswordView {
	const feedback = passwordFeedback(password, breach);
	return { feedback, mismatch: confirm !== "" && confirm !== password, canSubmit: feedback.acceptable && confirm === password && !busy };
}
