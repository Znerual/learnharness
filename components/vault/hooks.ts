// Hooks shared by the vault screens.

import { useEffect, useState } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { passwordFeedback, type BreachState, type PasswordCheckResult } from "@/src/core";
import type { PasskeyAvailabilityDto, ReauthEvent } from "@/src/core";

/**
 * Asks the server for the breach check once the password is long enough, 400 ms after the
 * learner stops typing. The result carries the password it belongs to, so a stale answer is ignored.
 */
export function useBreachCheck(api: VaultApi, password: string, breach: BreachState | null, onResult: (password: string, result: PasswordCheckResult) => void): void {
	const needs = passwordFeedback(password, breach).needsCheck;
	useEffect(() => {
		if (!needs) return;
		const t = setTimeout(() => {
			api.passwordCheck({ password })
				.then((result) => onResult(password, result))
				// the check is advisory; if it cannot run, the server's own check at submit decides
				.catch(() => onResult(password, { ok: true, onlineChecked: false }));
		}, 400);
		return () => clearTimeout(t);
	}, [api, password, needs, onResult]);
}

/** Runs one re-authentication call and reports the grant handle or the failure to the model. */
export async function runReauth(api: VaultApi, dispatch: (e: ReauthEvent) => void, kind: "password" | "recovery", value: string, now: () => number = Date.now): Promise<void> {
	try {
		const r = kind === "password" ? await api.reauthPassword({ password: value }) : await api.reauthRecovery({ secret: value });
		dispatch({ type: "granted", reauthId: r.reauthId, strength: r.strength, now: now() });
	} catch (e) {
		dispatch({ type: "failed", code: errorCode(e) });
	}
}

/**
 * Passkey re-authentication. The ceremony runs in the server process and the desktop passkey
 * window (ADR 0004); this call returns the grant handle like the other methods.
 */
export async function runPasskeyReauth(api: VaultApi, dispatch: (e: ReauthEvent) => void, now: () => number = Date.now): Promise<void> {
	try {
		const r = await api.reauthPasskey();
		dispatch({ type: "granted", reauthId: r.reauthId, strength: r.strength, now: now() });
	} catch (e) {
		dispatch({ type: "failed", code: errorCode(e) });
	}
}

/** Whether the passkey ceremony can run here (desktop app with a passkey-capable server); null until answered. */
export function usePasskeyAvailability(api: VaultApi): PasskeyAvailabilityDto | null {
	const [availability, setAvailability] = useState<PasskeyAvailabilityDto | null>(null);
	useEffect(() => {
		let live = true;
		api.passkeyAvailability()
			.then((a) => live && setAvailability(a))
			.catch(() => live && setAvailability({ available: false, reason: "bridge_missing" }));
		return () => {
			live = false;
		};
	}, [api]);
	return availability;
}
