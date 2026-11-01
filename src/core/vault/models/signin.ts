// Sign-in (#28, #30, ADR 0003, ADR 0004): password, or passkey. A passkey without PRF support
// signs in but cannot unlock; the learner then picks one of three ways to unlock: password,
// pairing from another signed-in device, or recovery material.

import type { SessionDto } from "../contract.ts";
import { looksLikeEmail } from "./signup.ts";

interface Common {
	busy: boolean;
	error?: string;
}

export type UnlockChoice = "password" | "pairing" | "recovery";

export type SignInState =
	| ({ step: "form"; email: string; password: string; passkeyWaiting: boolean } & Common)
	| ({ step: "needs_unlock"; email: string; password: string } & Common)
	/** The screen leaves this flow and opens another one. */
	| { step: "handoff"; to: "recover" | "pairing"; email: string; busy: false }
	| { step: "signed_in"; busy: false };

export type SignInEvent =
	| { type: "email_changed"; email: string }
	| { type: "password_changed"; password: string }
	| { type: "submit_password" }
	| { type: "passkey_started" }
	| { type: "passkey_cancelled" }
	| { type: "session"; session: SessionDto }
	| { type: "choose"; choice: UnlockChoice }
	| { type: "submit_unlock" }
	| { type: "forgot_password" }
	| { type: "failed"; code: string };

export function initialSignIn(email = ""): SignInState {
	return { step: "form", email, password: "", passkeyWaiting: false, busy: false };
}

function afterSession(s: SignInState, session: SessionDto): SignInState {
	const email = "email" in s ? s.email : "";
	switch (session.state) {
		case "signed_in":
			return { step: "signed_in", busy: false };
		case "needs_unlock":
			return { step: "needs_unlock", email: session.email || email, password: "", busy: false };
		case "must_set_password":
			return { step: "handoff", to: "recover", email, busy: false };
		case "signed_out":
			return { ...(s as Extract<SignInState, { step: "form" }>), busy: false, passkeyWaiting: false, error: "login_failed" };
	}
}

export function reduceSignIn(s: SignInState, e: SignInEvent): SignInState {
	if (s.step === "signed_in" || s.step === "handoff") return s;
	if (e.type === "failed") return { ...s, busy: false, ...(s.step === "form" ? { passkeyWaiting: false } : {}), error: e.code } as SignInState;
	if (e.type === "session") return afterSession(s, e.session);
	if (e.type === "passkey_cancelled" && s.step === "form") return { ...s, busy: false, passkeyWaiting: false, error: "passkey_cancelled" };
	if (s.busy) return s;
	if (s.step === "form") {
		switch (e.type) {
			case "email_changed":
				return { ...s, email: e.email, error: undefined };
			case "password_changed":
				return { ...s, password: e.password, error: undefined };
			case "submit_password":
				return looksLikeEmail(s.email) && s.password ? { ...s, busy: true, error: undefined } : s;
			case "passkey_started":
				return looksLikeEmail(s.email) ? { ...s, busy: true, passkeyWaiting: true, error: undefined } : { ...s, error: "bad_request" };
			case "passkey_cancelled":
				return { ...s, busy: false, passkeyWaiting: false, error: "passkey_cancelled" };
			case "forgot_password":
				return { step: "handoff", to: "recover", email: s.email, busy: false };
			default:
				return s;
		}
	}
	// needs_unlock
	switch (e.type) {
		case "password_changed":
			return { ...s, password: e.password, error: undefined };
		case "choose":
			if (e.choice === "pairing") return { step: "handoff", to: "pairing", email: s.email, busy: false };
			if (e.choice === "recovery") return { step: "handoff", to: "recover", email: s.email, busy: false };
			return s;
		case "submit_unlock":
			return s.password ? { ...s, busy: true, error: undefined } : s;
		default:
			return s;
	}
}

/** The three ways out of "signed in, needs unlock", in the order the screen lists them. */
export const unlockChoices: readonly UnlockChoice[] = ["password", "pairing", "recovery"];
