// Devices (#32, #33, ADR 0006, ADR 0013): the list with badges, rename, "Sign out this device"
// (no rotation) versus "Revoke lost device" (re-authentication, rotation, 24 h wait unless the
// grant came from recovery material), and the pending action with confirm and cancel.

import type { RotationDto } from "../contract.ts";
import type { DeviceRow, PendingAction } from "../deps.ts";
import { formatDate, relativeTime } from "../format.ts";
import { strings } from "../strings.ts";
import { initialReauth, reduceReauth, type ReauthEvent, type ReauthState } from "./reauth.ts";

export type DevicesNotice =
	| { kind: "revoked"; name: string }
	| { kind: "revoke_pending"; name: string; runsAt: string }
	| { kind: "signed_out" }
	| { kind: "pending_confirmed" }
	| { kind: "pending_cancelled" };

export type DevicesAction =
	| { kind: "sign_out_confirm" }
	| { kind: "revoke"; deviceId: string; name: string; reauth: ReauthState; submitted: boolean }
	/** Confirming or cancelling the pending action; both re-authenticate first (confirm: passkey or recovery only). */
	| { kind: "pending"; op: "confirm" | "cancel"; id: string; reauth: ReauthState; submitted: boolean };

export interface DevicesState {
	devices: DeviceRow[];
	pending: PendingAction | null;
	/** Count of passkeys, to offer the passkey re-authentication method. */
	passkeys: number;
	rename: { deviceId: string; value: string } | null;
	action: DevicesAction | null;
	notice: DevicesNotice | null;
	busy: boolean;
	error?: string;
}

export type DevicesEvent =
	| { type: "loaded"; devices: DeviceRow[]; pending: PendingAction | null; passkeys?: number }
	| { type: "rename_start"; deviceId: string }
	| { type: "rename_changed"; value: string }
	| { type: "rename_submit" }
	| { type: "rename_done" }
	| { type: "rename_cancel" }
	| { type: "sign_out_ask" }
	| { type: "sign_out_done" }
	| { type: "revoke_ask"; deviceId: string }
	| { type: "reauth"; event: ReauthEvent }
	| { type: "revoke_submitted" }
	| { type: "revoke_result"; outcome: RotationDto }
	| { type: "action_cancel" }
	| { type: "pending_confirm" }
	| { type: "pending_cancel" }
	| { type: "pending_submitted" }
	| { type: "pending_done"; kind: "confirmed" | "cancelled" }
	| { type: "dismiss_notice" }
	| { type: "failed"; code: string };

export function initialDevices(): DevicesState {
	return { devices: [], pending: null, passkeys: 0, rename: null, action: null, notice: null, busy: false };
}

/** Device names are 1 to 64 characters after trimming (the client's checkDeviceName). */
export function validDeviceName(name: string): boolean {
	const n = name.trim();
	return n.length >= 1 && [...n].length <= 64;
}

export function reduceDevices(s: DevicesState, e: DevicesEvent): DevicesState {
	switch (e.type) {
		case "loaded":
			return { ...s, devices: e.devices, pending: e.pending, passkeys: e.passkeys ?? s.passkeys, busy: false };
		case "failed":
			return { ...s, busy: false, error: e.code, ...(s.action?.kind === "revoke" || s.action?.kind === "pending" ? { action: { ...s.action, submitted: false, reauth: s.action.reauth.step === "granted" ? initialReauth(s.passkeys, s.action.kind === "pending" && s.action.op === "confirm") : s.action.reauth } } : {}) };
		case "dismiss_notice":
			return { ...s, notice: null };
		case "rename_start": {
			const d = s.devices.find((x) => x.id === e.deviceId);
			return d ? { ...s, rename: { deviceId: d.id, value: d.name }, error: undefined } : s;
		}
		case "rename_changed":
			return s.rename ? { ...s, rename: { ...s.rename, value: e.value }, error: undefined } : s;
		case "rename_submit":
			return s.rename && validDeviceName(s.rename.value) ? { ...s, busy: true, error: undefined } : s.rename ? { ...s, error: "bad_request" } : s;
		case "rename_done":
			return { ...s, rename: null, busy: false };
		case "rename_cancel":
			return { ...s, rename: null, error: undefined };
		case "sign_out_ask":
			return { ...s, action: { kind: "sign_out_confirm" }, error: undefined };
		case "sign_out_done":
			return { ...s, action: null, notice: { kind: "signed_out" }, devices: [], pending: null, busy: false };
		case "revoke_ask": {
			const d = s.devices.find((x) => x.id === e.deviceId);
			if (!d || d.current) return s; // the current device signs out instead
			return { ...s, action: { kind: "revoke", deviceId: d.id, name: d.name, reauth: initialReauth(s.passkeys), submitted: false }, error: undefined };
		}
		case "reauth":
			return s.action?.kind === "revoke" || s.action?.kind === "pending" ? { ...s, action: { ...s.action, reauth: reduceReauth(s.action.reauth, e.event) } } : s;
		case "revoke_submitted":
			return s.action?.kind === "revoke" && s.action.reauth.step === "granted" ? { ...s, busy: true, action: { ...s.action, submitted: true } } : s;
		case "revoke_result": {
			if (s.action?.kind !== "revoke") return s;
			const name = s.action.name;
			const notice: DevicesNotice = e.outcome.status === "applied" ? { kind: "revoked", name } : { kind: "revoke_pending", name, runsAt: e.outcome.pendingAction.runsAt };
			const devices = e.outcome.status === "applied" ? s.devices.filter((d) => d.id !== (s.action as { deviceId: string }).deviceId) : s.devices;
			return { ...s, action: null, notice, busy: false, devices, pending: e.outcome.status === "pending" ? e.outcome.pendingAction : s.pending };
		}
		case "action_cancel":
			return s.busy ? s : { ...s, action: null, error: undefined };
		case "pending_confirm":
		case "pending_cancel": {
			if (!s.pending) return s;
			const op = e.type === "pending_confirm" ? "confirm" : "cancel";
			return { ...s, error: undefined, action: { kind: "pending", op, id: s.pending.id, reauth: initialReauth(s.passkeys, op === "confirm"), submitted: false } };
		}
		case "pending_submitted":
			return s.action?.kind === "pending" && s.action.reauth.step === "granted" ? { ...s, busy: true, action: { ...s.action, submitted: true } } : s;
		case "pending_done":
			return { ...s, action: null, pending: null, busy: false, notice: { kind: e.kind === "confirmed" ? "pending_confirmed" : "pending_cancelled" } };
	}
}

/** Set when the revoke dialog holds a fresh grant and the route call has not been made yet. */
export function revokeCallReady(s: DevicesState): { deviceId: string; reauthId: string } | null {
	const a = s.action;
	if (a?.kind !== "revoke" || a.submitted || a.reauth.step !== "granted") return null;
	return { deviceId: a.deviceId, reauthId: a.reauth.reauthId };
}

/** Set when the pending-action dialog holds a fresh grant and the route call has not been made yet. */
export function pendingCallReady(s: DevicesState): { op: "confirm" | "cancel"; id: string; reauthId: string } | null {
	const a = s.action;
	if (a?.kind !== "pending" || a.submitted || a.reauth.step !== "granted") return null;
	return { op: a.op, id: a.id, reauthId: a.reauth.reauthId };
}

export type BadgeId = "current" | "established" | "keys_not_protected" | "ephemeral";

export interface DeviceView {
	id: string;
	name: string;
	badges: { id: BadgeId; label: string; help?: string }[];
	meta: string[];
	/** Actions offered for this row. The current device signs out, other devices are revoked. */
	actions: ("rename" | "sign_out" | "revoke")[];
	renaming: boolean;
}

export function deviceView(d: DeviceRow, now: Date, renaming = false): DeviceView {
	const badges: DeviceView["badges"] = [];
	if (d.current) badges.push({ id: "current", label: strings.devices.thisDevice });
	if (d.established) badges.push({ id: "established", label: strings.devices.established, help: strings.devices.establishedHelp });
	if (!d.keysProtected) badges.push({ id: "keys_not_protected", label: strings.devices.keysNotProtected, help: strings.devices.keysNotProtectedHelp });
	if (d.ephemeral) badges.push({ id: "ephemeral", label: strings.devices.ephemeral, help: strings.devices.ephemeralHelp });
	return {
		id: d.id,
		name: d.name,
		badges,
		meta: [strings.devices.lastSeen(relativeTime(d.lastSeenAt, now)), strings.devices.addedOn(formatDate(d.createdAt))],
		actions: d.current ? ["rename", "sign_out"] : ["rename", "revoke"],
		renaming,
	};
}

/** The current device first, then the others by most recent use. */
export function sortedDevices(devices: DeviceRow[]): DeviceRow[] {
	return [...devices].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

export interface PendingView {
	id: string;
	title: string;
	requestedBy: string;
	runs: string;
	canConfirm: boolean;
	canCancel: boolean;
	/** Why a button is missing, if it is. */
	notes: string[];
}

export function pendingView(p: PendingAction, devices: DeviceRow[], now: Date): PendingView {
	const target = devices.find((d) => d.id === p.targetDeviceId);
	const me = devices.find((d) => d.current);
	const title = p.kind === "revoke_device" ? strings.devices.pendingRevoke(target?.name ?? "a device") : p.kind === "regenerate_recovery_key" ? strings.devices.pendingRegenKey : strings.devices.pendingRegenCodes;
	const canConfirm = !!me && me.established && p.requestedBy !== me.id;
	// the device a pending revocation targets cannot cancel it (server: not_cancellable)
	const targetsMe = p.kind === "revoke_device" && !!me && p.targetDeviceId === me.id;
	const canCancel = p.cancellable && !targetsMe;
	const notes: string[] = [];
	if (!canConfirm) notes.push(strings.devices.pendingCannotConfirm);
	if (!p.cancellable) notes.push(strings.devices.pendingCannotCancel);
	else if (targetsMe) notes.push(strings.devices.pendingCannotCancelTarget);
	if (canConfirm) notes.push(strings.devices.pendingConfirmStrong);
	return { id: p.id, title, requestedBy: strings.devices.pendingRequestedBy(p.requestedByName), runs: strings.devices.pendingRuns(relativeTime(p.runsAt, now)), canConfirm, canCancel, notes };
}
