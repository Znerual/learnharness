// Delete account (ADR 0010, ADR 0013): offer an export first, then type the account email, then
// re-authenticate, then delete. Deletion is permanent on the server; local files stay.

import { initialReauth, reduceReauth, type ReauthEvent, type ReauthState } from "./reauth.ts";

export type DeleteAccountState =
	| { step: "export"; exported: boolean; busy: boolean; error?: string }
	| { step: "email"; exported: boolean; typed: string }
	| { step: "reauth"; exported: boolean; reauth: ReauthState; submitted: boolean; error?: string }
	| { step: "done" };

export type DeleteAccountEvent =
	| { type: "export_start" }
	| { type: "export_done" }
	| { type: "export_failed"; code: string }
	| { type: "continue" }
	| { type: "typed_changed"; typed: string }
	| { type: "reauth"; event: ReauthEvent }
	| { type: "submitted" }
	| { type: "deleted" }
	| { type: "failed"; code: string };

export const initialDeleteAccount: DeleteAccountState = { step: "export", exported: false, busy: false };

/** Email comparison is case-insensitive and ignores surrounding space; accounts are stored lower case. */
export function emailMatches(typed: string, accountEmail: string): boolean {
	return typed.trim().toLowerCase() === accountEmail.trim().toLowerCase() && accountEmail.trim() !== "";
}

export function reduceDeleteAccount(s: DeleteAccountState, e: DeleteAccountEvent, accountEmail: string, passkeys = 0): DeleteAccountState {
	switch (s.step) {
		case "export":
			if (e.type === "export_start") return s.busy ? s : { ...s, busy: true, error: undefined };
			if (e.type === "export_done") return { ...s, exported: true, busy: false };
			if (e.type === "export_failed") return { ...s, busy: false, error: e.code };
			// continuing without an export is an explicit choice, the screen labels it
			if (e.type === "continue") return s.busy ? s : { step: "email", exported: s.exported, typed: "" };
			return s;
		case "email":
			if (e.type === "typed_changed") return { ...s, typed: e.typed };
			if (e.type === "continue") return emailMatches(s.typed, accountEmail) ? { step: "reauth", exported: s.exported, reauth: initialReauth(passkeys), submitted: false } : s;
			return s;
		case "reauth":
			if (e.type === "reauth") return { ...s, reauth: reduceReauth(s.reauth, e.event) };
			if (e.type === "submitted") return s.reauth.step === "granted" && !s.submitted ? { ...s, submitted: true } : s;
			if (e.type === "deleted") return { step: "done" };
			if (e.type === "failed") return { ...s, submitted: false, reauth: initialReauth(passkeys), error: e.code };
			return s;
		case "done":
			return s;
	}
}

/** The delete call is ready: the grant is fresh and not yet used. */
export function deleteCallReady(s: DeleteAccountState): string | null {
	return s.step === "reauth" && !s.submitted && s.reauth.step === "granted" ? s.reauth.reauthId : null;
}
