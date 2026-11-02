// Sign-up flow (#28, ADR 0004, ADR 0005): email, code, password with live rules, the recovery key
// and ten backup codes shown once, the emergency kit, and a confirmation step that needs one
// backup code or the last 4 characters of the recovery key. Pure reducer, no I/O: the screen
// performs the call for each submit event and reports back with a success or failure event.

import type { EmergencyKit } from "../deps.ts";
import { passwordFeedback, type BreachState, type PasswordCheckResult, type PasswordFeedback } from "./password.ts";

export interface SignupMaterial {
	recoveryKey: string;
	backupCodes: string[];
	kit: EmergencyKit;
}

interface Common {
	busy: boolean;
	/** Error code, mapped to text by errorText. */
	error?: string;
}

export type SignupState =
	| ({ step: "email"; email: string } & Common)
	| ({ step: "code"; email: string; code: string } & Common)
	| ({ step: "password"; email: string; password: string; confirm: string; breach: BreachState | null } & Common)
	| ({ step: "secrets"; email: string; material: SignupMaterial; acknowledged: boolean } & Common)
	| ({ step: "kit"; email: string; material: SignupMaterial; kitOpened: boolean } & Common)
	| ({ step: "confirm"; email: string; material: SignupMaterial; typed: string; attempts: number } & Common)
	| { step: "done"; email: string; busy: false };

export type SignupEvent =
	| { type: "email_changed"; email: string }
	| { type: "submit_email" }
	| { type: "email_sent" }
	| { type: "code_changed"; code: string }
	| { type: "submit_code" }
	| { type: "code_verified" }
	| { type: "password_changed"; password: string }
	| { type: "confirm_changed"; confirm: string }
	| { type: "breach_result"; password: string; result: PasswordCheckResult }
	| { type: "submit_password" }
	| { type: "finished"; material: SignupMaterial }
	| { type: "failed"; code: string }
	| { type: "acknowledged"; value: boolean }
	| { type: "next" }
	| { type: "kit_opened" }
	| { type: "typed_changed"; typed: string }
	| { type: "submit_confirm" }
	| { type: "confirm_result"; ok: boolean }
	| { type: "show_again" }
	| { type: "resend_code" };

export const SIGNUP_STEPS = ["email", "code", "password", "secrets", "kit", "confirm"] as const;

export function initialSignup(email = ""): SignupState {
	return { step: "email", email, busy: false };
}

export function looksLikeEmail(s: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** Signup codes are 8 characters; spaces and dashes are ignored. */
export function normalizeCode(s: string): string {
	return s.replace(/[\s-]/g, "").toUpperCase();
}

export function reduceSignup(s: SignupState, e: SignupEvent): SignupState {
	if (s.step === "done") return s;
	if (e.type === "failed") return { ...s, busy: false, error: e.code } as SignupState;
	if (s.busy && e.type !== "email_sent" && e.type !== "code_verified" && e.type !== "finished" && e.type !== "confirm_result" && e.type !== "breach_result") return s;
	switch (s.step) {
		case "email":
			if (e.type === "email_changed") return { ...s, email: e.email, error: undefined };
			if (e.type === "submit_email") return looksLikeEmail(s.email) ? { ...s, email: s.email.trim(), busy: true, error: undefined } : { ...s, error: "bad_request" };
			if (e.type === "email_sent") return { step: "code", email: s.email, code: "", busy: false };
			return s;
		case "code":
			if (e.type === "code_changed") return { ...s, code: e.code, error: undefined };
			if (e.type === "submit_code") return normalizeCode(s.code).length === 8 ? { ...s, busy: true, error: undefined } : { ...s, error: "bad_code" };
			if (e.type === "resend_code") return { ...s, busy: true, error: undefined };
			if (e.type === "email_sent") return { ...s, busy: false, code: "" };
			if (e.type === "code_verified") return { step: "password", email: s.email, password: "", confirm: "", breach: null, busy: false };
			return s;
		case "password":
			if (e.type === "password_changed") return { ...s, password: e.password, error: undefined };
			if (e.type === "confirm_changed") return { ...s, confirm: e.confirm };
			if (e.type === "breach_result") return { ...s, breach: { forPassword: e.password, result: e.result } };
			if (e.type === "submit_password") return signupPasswordView(s).canSubmit ? { ...s, busy: true, error: undefined } : s;
			if (e.type === "finished") return { step: "secrets", email: s.email, material: e.material, acknowledged: false, busy: false };
			return s;
		case "secrets":
			if (e.type === "acknowledged") return { ...s, acknowledged: e.value };
			if (e.type === "next" && s.acknowledged) return { step: "kit", email: s.email, material: s.material, kitOpened: false, busy: false };
			return s;
		case "kit":
			if (e.type === "kit_opened") return { ...s, kitOpened: true };
			if (e.type === "next") return { step: "confirm", email: s.email, material: s.material, typed: "", attempts: 0, busy: false };
			return s;
		case "confirm":
			if (e.type === "typed_changed") return { ...s, typed: e.typed, error: undefined };
			if (e.type === "submit_confirm") return s.typed.trim() ? { ...s, busy: true, error: undefined } : s;
			if (e.type === "confirm_result") return e.ok ? { step: "done", email: s.email, busy: false } : { ...s, busy: false, attempts: s.attempts + 1, error: "confirm_wrong" };
			if (e.type === "show_again") return { step: "secrets", email: s.email, material: s.material, acknowledged: false, busy: false };
			return s;
	}
}

export interface SignupPasswordView {
	feedback: PasswordFeedback;
	mismatch: boolean;
	canSubmit: boolean;
}

export function signupPasswordView(s: Extract<SignupState, { step: "password" }>): SignupPasswordView {
	const feedback = passwordFeedback(s.password, s.breach);
	const mismatch = s.confirm !== "" && s.confirm !== s.password;
	return { feedback, mismatch, canSubmit: feedback.acceptable && s.confirm === s.password && !s.busy };
}

/** Index of the current step in SIGNUP_STEPS for a progress indicator; -1 when done. */
export function signupStepIndex(s: SignupState): number {
	return s.step === "done" ? -1 : SIGNUP_STEPS.indexOf(s.step);
}

/** The recovery key, backup codes and kit are visible on the one-time screens only. */
export function visibleSecrets(s: SignupState): SignupMaterial | null {
	return s.step === "secrets" || s.step === "kit" ? s.material : null;
}
