// Unlock on launch (ADR 0003): the server process opens the vault from secure storage and the
// UI shows what happened. Normally this is invisible; it matters when the token expired, when
// the server is offline, or when a recovery sign-in still needs a new password.

import type { SessionDto } from "../contract.ts";
import { strings } from "../strings.ts";

export type UnlockState =
	| { step: "checking" }
	| { step: "ready"; offline: boolean }
	| { step: "signed_out"; reason: "none" | "expired" }
	| { step: "needs_unlock" }
	| { step: "must_set_password" }
	| { step: "failed"; error: string };

export type UnlockEvent = { type: "session"; session: SessionDto } | { type: "failed"; code: string };

export const initialUnlock: UnlockState = { step: "checking" };

export function reduceUnlock(s: UnlockState, e: UnlockEvent): UnlockState {
	if (e.type === "failed") return e.code === "signed_out" ? { step: "signed_out", reason: "expired" } : { step: "failed", error: e.code };
	switch (e.session.state) {
		case "signed_in":
			return { step: "ready", offline: e.session.offline };
		case "signed_out":
			return { step: "signed_out", reason: "none" };
		case "needs_unlock":
			return { step: "needs_unlock" };
		case "must_set_password":
			return { step: "must_set_password" };
	}
}

export interface UnlockView {
	title: string;
	body: string;
	/** What the single button does; null when nothing is needed. */
	action: "sign_in" | "retry" | "unlock" | "set_password" | null;
	/** True while the app should be usable behind or instead of this screen. */
	appUsable: boolean;
}

export function unlockView(s: UnlockState): UnlockView {
	switch (s.step) {
		case "checking":
			return { title: strings.unlock.title, body: strings.unlock.working, action: null, appUsable: false };
		case "ready":
			return s.offline
				? { title: strings.unlock.offlineTitle, body: strings.unlock.offlineHelp, action: null, appUsable: true }
				: { title: strings.unlock.title, body: "", action: null, appUsable: true };
		case "signed_out":
			return s.reason === "expired"
				? { title: strings.unlock.signedOutTitle, body: strings.unlock.signedOutHelp, action: "sign_in", appUsable: false }
				: { title: strings.signin.title, body: "", action: "sign_in", appUsable: false };
		case "needs_unlock":
			return { title: strings.signin.signedInNeedsUnlockTitle, body: strings.signin.signedInNeedsUnlockHelp, action: "unlock", appUsable: false };
		case "must_set_password":
			return { title: strings.recover.newPasswordTitle, body: strings.recover.newPasswordHelp, action: "set_password", appUsable: false };
		case "failed":
			return { title: strings.unlock.failedTitle, body: "", action: "retry", appUsable: false };
	}
}
