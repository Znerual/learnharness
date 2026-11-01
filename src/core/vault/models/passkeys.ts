// Passkeys (ADR 0004, ADR 0013): list, add and remove. Adding and removing re-authenticate first
// (they are sensitive actions). Removing a passkey that can unlock rotates the keys. The WebAuthn
// ceremony of "add" runs in the server process and the desktop passkey window; this model only
// sees the route call, which stays "working" while the learner touches the key.

import type { PasskeyAvailabilityDto, PasskeyRow, RotationDto } from "../contract.ts";
import { formatDateTime } from "../format.ts";
import { strings } from "../strings.ts";
import { initialReauth, reduceReauth, type ReauthEvent, type ReauthState } from "./reauth.ts";

export type PasskeysAction =
	| { kind: "add"; step: "name"; name: string }
	| { kind: "add"; step: "reauth"; name: string; reauth: ReauthState; submitted: boolean }
	| { kind: "remove"; passkey: PasskeyRow; reauth: ReauthState; submitted: boolean };

export type PasskeysNotice =
	| { kind: "added"; name: string; signInOnly: boolean }
	| { kind: "removed"; name: string }
	| { kind: "remove_pending"; name: string; runsAt: string };

export interface PasskeysState {
	rows: PasskeyRow[];
	availability: PasskeyAvailabilityDto | null;
	/** Whether the account has a passkey that can re-authenticate here; set by `loaded`. */
	reauthPasskeys: number;
	action: PasskeysAction | null;
	notice: PasskeysNotice | null;
	busy: boolean;
	error?: string;
}

export type PasskeysEvent =
	| { type: "loaded"; rows: PasskeyRow[]; availability: PasskeyAvailabilityDto; reauthPasskeys: number }
	| { type: "add_start" }
	| { type: "name_changed"; name: string }
	| { type: "name_continue" }
	| { type: "remove_ask"; id: string }
	| { type: "reauth"; event: ReauthEvent }
	| { type: "submitted" }
	| { type: "added"; row: PasskeyRow }
	| { type: "removed"; outcome: RotationDto }
	| { type: "cancel" }
	| { type: "dismiss_notice" }
	| { type: "failed"; code: string };

export const PASSKEY_NAME_MAX = 64;

export function initialPasskeys(): PasskeysState {
	return { rows: [], availability: null, reauthPasskeys: 0, action: null, notice: null, busy: false };
}

export function validPasskeyName(name: string): boolean {
	const n = name.trim();
	return n.length >= 1 && [...n].length <= PASSKEY_NAME_MAX;
}

/** Adding needs the ceremony; the list and removal work everywhere. */
export function canAddPasskey(s: Pick<PasskeysState, "availability">): boolean {
	return s.availability?.available === true;
}

export function reducePasskeys(s: PasskeysState, e: PasskeysEvent): PasskeysState {
	switch (e.type) {
		case "loaded":
			return { ...s, rows: e.rows, availability: e.availability, reauthPasskeys: e.reauthPasskeys, busy: false };
		case "dismiss_notice":
			return { ...s, notice: null };
		case "failed": {
			const a = s.action;
			// a grant is single-use: after a failed action the learner confirms again
			if (a && a.kind === "add" && a.step === "reauth") return { ...s, busy: false, error: e.code, action: { ...a, submitted: false, reauth: initialReauth(s.reauthPasskeys) } };
			if (a && a.kind === "remove") return { ...s, busy: false, error: e.code, action: { ...a, submitted: false, reauth: initialReauth(s.reauthPasskeys) } };
			return { ...s, busy: false, error: e.code };
		}
		case "add_start":
			return canAddPasskey(s) ? { ...s, action: { kind: "add", step: "name", name: "" }, notice: null, error: undefined } : s;
		case "name_changed":
			return s.action?.kind === "add" && s.action.step === "name" ? { ...s, action: { ...s.action, name: e.name }, error: undefined } : s;
		case "name_continue":
			return s.action?.kind === "add" && s.action.step === "name" && validPasskeyName(s.action.name)
				? { ...s, action: { kind: "add", step: "reauth", name: s.action.name.trim(), reauth: initialReauth(s.reauthPasskeys), submitted: false } }
				: s.action?.kind === "add" && s.action.step === "name"
					? { ...s, error: "bad_request" }
					: s;
		case "remove_ask": {
			const passkey = s.rows.find((r) => r.id === e.id);
			return passkey ? { ...s, notice: null, error: undefined, action: { kind: "remove", passkey, reauth: initialReauth(s.reauthPasskeys), submitted: false } } : s;
		}
		case "reauth": {
			const a = s.action;
			if (a && ((a.kind === "add" && a.step === "reauth") || a.kind === "remove")) return { ...s, action: { ...a, reauth: reduceReauth(a.reauth, e.event) } };
			return s;
		}
		case "submitted": {
			const a = s.action;
			if (a && ((a.kind === "add" && a.step === "reauth") || a.kind === "remove") && a.reauth.step === "granted") return { ...s, busy: true, action: { ...a, submitted: true } };
			return s;
		}
		case "added":
			return { ...s, action: null, busy: false, rows: [...s.rows, e.row], reauthPasskeys: s.reauthPasskeys + 1, notice: { kind: "added", name: e.row.name, signInOnly: e.row.signInOnly } };
		case "removed": {
			if (s.action?.kind !== "remove") return s;
			const { passkey } = s.action;
			if (e.outcome.status === "pending") return { ...s, action: null, busy: false, notice: { kind: "remove_pending", name: passkey.name, runsAt: e.outcome.pendingAction.runsAt } };
			return { ...s, action: null, busy: false, rows: s.rows.filter((r) => r.id !== passkey.id), reauthPasskeys: Math.max(0, s.reauthPasskeys - 1), notice: { kind: "removed", name: passkey.name } };
		}
		case "cancel":
			return s.busy ? s : { ...s, action: null, error: undefined };
	}
}

/** Set when the add or remove dialog holds a fresh grant and the route call has not been made yet. */
export function passkeyCallReady(s: PasskeysState): { op: "add"; name: string; reauthId: string } | { op: "remove"; passkeyId: string; reauthId: string } | null {
	const a = s.action;
	if (!a || (a.kind === "add" && a.step === "name") || a.submitted || a.reauth.step !== "granted") return null;
	return a.kind === "add" ? { op: "add", name: a.name, reauthId: a.reauth.reauthId } : { op: "remove", passkeyId: a.passkey.id, reauthId: a.reauth.reauthId };
}

export function passkeyNoticeText(n: PasskeysNotice): string {
	switch (n.kind) {
		case "added":
			return n.signInOnly ? strings.passkeys.addedSignInOnly(n.name) : strings.passkeys.added(n.name);
		case "removed":
			return strings.passkeys.removed(n.name);
		case "remove_pending":
			return strings.passkeys.removePending(n.name, formatDateTime(n.runsAt));
	}
}
