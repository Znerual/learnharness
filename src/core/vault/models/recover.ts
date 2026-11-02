// Recovery sign-in (#29, ADR 0005): recovery key or a backup code, then a forced new password.
// Sync does not start before the new password is set. The same state machine serves a device
// that already has a recovery session ("must_set_password" at launch) via `initialRecover("new_password")`.

import type { SessionDto } from "../contract.ts";
import { newPasswordView, type BreachState, type NewPasswordView, type PasswordCheckResult } from "./password.ts";
import { looksLikeEmail } from "./signup.ts";

interface Common {
	busy: boolean;
	error?: string;
}

export type RecoverState =
	| ({ step: "form"; email: string; secret: string } & Common)
	| ({ step: "new_password"; password: string; confirm: string; breach: BreachState | null } & Common)
	| { step: "done"; pending: boolean; busy: false };

export type RecoverEvent =
	| { type: "email_changed"; email: string }
	| { type: "secret_changed"; secret: string }
	| { type: "submit_secret" }
	| { type: "session"; session: SessionDto }
	| { type: "password_changed"; password: string }
	| { type: "confirm_changed"; confirm: string }
	| { type: "breach_result"; password: string; result: PasswordCheckResult }
	| { type: "submit_password" }
	| { type: "password_set"; pending: boolean }
	| { type: "failed"; code: string };

export function initialRecover(step: "form" | "new_password" = "form", email = ""): RecoverState {
	return step === "form" ? { step: "form", email, secret: "", busy: false } : { step: "new_password", password: "", confirm: "", breach: null, busy: false };
}

/** Recovery keys and backup codes are long; reject obvious typos before the round trip. */
export function plausibleSecret(s: string): boolean {
	return s.replace(/[\s-]/g, "").length >= 8;
}

export function recoverPasswordView(s: Extract<RecoverState, { step: "new_password" }>): NewPasswordView {
	return newPasswordView(s.password, s.confirm, s.breach, s.busy);
}

export function reduceRecover(s: RecoverState, e: RecoverEvent): RecoverState {
	if (s.step === "done") return s;
	if (e.type === "failed") return { ...s, busy: false, error: e.code };
	if (s.step === "form") {
		if (e.type === "session" && s.busy) return e.session.state === "must_set_password" ? initialRecover("new_password") : { ...s, busy: false, error: "login_failed" };
		if (s.busy) return s;
		switch (e.type) {
			case "email_changed":
				return { ...s, email: e.email, error: undefined };
			case "secret_changed":
				return { ...s, secret: e.secret, error: undefined };
			case "submit_secret":
				if (!looksLikeEmail(s.email)) return { ...s, error: "bad_request" };
				if (!plausibleSecret(s.secret)) return { ...s, error: "bad_code" };
				return { ...s, email: s.email.trim(), busy: true, error: undefined };
			default:
				return s;
		}
	}
	// new_password
	if (e.type === "password_set" && s.busy) return { step: "done", pending: e.pending, busy: false };
	if (e.type === "breach_result") return { ...s, breach: { forPassword: e.password, result: e.result } };
	if (s.busy) return s;
	switch (e.type) {
		case "password_changed":
			return { ...s, password: e.password, error: undefined };
		case "confirm_changed":
			return { ...s, confirm: e.confirm };
		case "submit_password":
			return recoverPasswordView(s).canSubmit ? { ...s, busy: true, error: undefined } : s;
		default:
			return s;
	}
}
