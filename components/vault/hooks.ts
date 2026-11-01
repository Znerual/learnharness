// Hooks shared by the vault screens.

import { useEffect } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { passwordFeedback, type BreachState, type PasswordCheckResult } from "@/src/core";
import type { ReauthEvent } from "@/src/core";

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
 * Passkey re-authentication. The WebAuthn ceremony runs in the browser: the server returns the
 * options, the page calls navigator.credentials.get and posts the credential back.
 */
export async function runPasskeyReauth(api: VaultApi, dispatch: (e: ReauthEvent) => void, now: () => number = Date.now): Promise<void> {
	try {
		const start = await api.reauthPasskeyStart();
		const credential = await getCredential(start.options);
		const r = await api.reauthPasskeyFinish({ ceremonyId: start.ceremonyId, credential });
		dispatch({ type: "granted", reauthId: r.reauthId, strength: r.strength, now: now() });
	} catch (e) {
		dispatch({ type: "failed", code: e instanceof Error && e.name === "NotAllowedError" ? "passkey_cancelled" : errorCode(e) });
	}
}

// ---------------------------------------------------------------- WebAuthn bridge

type Json = Record<string, unknown>;

function b64urlToBytes(s: string): Uint8Array {
	const pad = "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(b: ArrayBuffer): string {
	let s = "";
	for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Browser-side `navigator.credentials.get` with JSON options and a JSON result (PRF output split off). */
export async function getCredential(options: unknown): Promise<unknown> {
	const { credential } = await getCredentialWithPrf(options);
	return credential;
}

export async function getCredentialWithPrf(options: unknown): Promise<{ credential: unknown; prfOutput: string | null }> {
	const o = ((options as Json)["publicKey"] ?? options) as Json;
	const allow = ((o["allowCredentials"] as Json[] | undefined) ?? []).map((c) => ({ ...c, id: b64urlToBytes(c["id"] as string) }));
	const ext = (o["extensions"] ?? {}) as Json;
	const prf = (ext["prf"] as { eval?: { first?: string } } | undefined)?.eval?.first;
	const publicKey = {
		...o,
		challenge: b64urlToBytes(o["challenge"] as string),
		allowCredentials: allow,
		extensions: prf ? { ...ext, prf: { eval: { first: b64urlToBytes(prf) } } } : ext,
	} as unknown as PublicKeyCredentialRequestOptions;
	const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
	if (!cred) throw new Error("no credential");
	const res = cred.response as AuthenticatorAssertionResponse;
	const ext2 = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
	const first = ext2.prf?.results?.first;
	return {
		prfOutput: first ? bytesToB64url(first).replace(/-/g, "+").replace(/_/g, "/") : null,
		credential: {
			id: cred.id,
			rawId: bytesToB64url(cred.rawId),
			type: cred.type,
			response: {
				authenticatorData: bytesToB64url(res.authenticatorData),
				clientDataJSON: bytesToB64url(res.clientDataJSON),
				signature: bytesToB64url(res.signature),
				userHandle: res.userHandle ? bytesToB64url(res.userHandle) : null,
			},
			clientExtensionResults: {},
		},
	};
}
