// Re-authentication before a sensitive action (ADR 0013). The server issues a grant valid for
// 5 minutes and one action; it stays on the server and the UI holds a short handle (`reauthId`).
// The learner picks password, passkey or recovery material. A backup code is used up.

import type { ReauthStrength } from "../contract.ts";

export type ReauthMethod = "password" | "passkey" | "recovery";

/** Server grants last 5 minutes; stop offering an old one a little earlier. */
export const REAUTH_TTL_MS = 4.5 * 60_000;

export type ReauthState =
	| { step: "form"; method: ReauthMethod; available: ReauthMethod[]; value: string; busy: boolean; error?: string }
	| { step: "granted"; reauthId: string; strength: ReauthStrength; grantedAt: number };

export type ReauthEvent =
	| { type: "method_changed"; method: ReauthMethod }
	| { type: "value_changed"; value: string }
	| { type: "submit" }
	| { type: "passkey_started" }
	| { type: "granted"; reauthId: string; strength: ReauthStrength; now: number }
	| { type: "failed"; code: string };

/** Passkey is offered only when the account has one registered. */
export function availableMethods(passkeys: number): ReauthMethod[] {
	return passkeys > 0 ? ["password", "passkey", "recovery"] : ["password", "recovery"];
}

/** `strongOnly` drops the password option (confirming a pending action needs passkey or recovery). */
export function initialReauth(passkeys = 0, strongOnly = false): ReauthState {
	const available = availableMethods(passkeys).filter((m) => !strongOnly || m !== "password");
	return { step: "form", method: available[0] ?? "recovery", available, value: "", busy: false };
}

export function reduceReauth(s: ReauthState, e: ReauthEvent): ReauthState {
	if (e.type === "granted") return { step: "granted", reauthId: e.reauthId, strength: e.strength, grantedAt: e.now };
	if (s.step === "granted") return s;
	if (e.type === "failed") return { ...s, busy: false, error: e.code };
	if (s.busy) return s;
	switch (e.type) {
		case "method_changed":
			return s.available.includes(e.method) ? { ...s, method: e.method, value: "", error: undefined } : s;
		case "value_changed":
			return { ...s, value: e.value, error: undefined };
		case "submit":
			return s.method !== "passkey" && s.value.trim() ? { ...s, busy: true, error: undefined } : s;
		case "passkey_started":
			return s.method === "passkey" ? { ...s, busy: true, error: undefined } : s;
		default:
			return s;
	}
}

export function reauthExpired(s: ReauthState, now: number): boolean {
	return s.step === "granted" && now - s.grantedAt > REAUTH_TTL_MS;
}

/** Recovery material is the strongest proof: delayed actions run at once with it. */
export function runsImmediately(strength: ReauthStrength): boolean {
	return strength === "recovery";
}
