// OPAQUE client (ADR 0004) with @serenity-kit/opaque 1.1.0: ristretto255-SHA512, Argon2id KSF,
// empty context, client identity = email, server identity from the server.

import * as opaque from "@serenity-kit/opaque";

import { fromB64, toB64 } from "./crypto/bytes.ts";

await opaque.ready;

/** Argon2id costs per KSF version. Version 1: t = 3, 64 MiB, p = 4 (ADR 0004). */
export const KSF_VERSIONS: Record<number, { iterations: number; memory: number; parallelism: number }> = {
	1: { iterations: 3, memory: 65536, parallelism: 4 },
};
export const CURRENT_KSF_VERSION = 1;

function keyStretching(version: number): { "argon2id-custom": { iterations: number; memory: number; parallelism: number } } {
	const p = KSF_VERSIONS[version];
	if (!p) throw new Error(`unsupported KSF version ${version}; update the app`);
	return { "argon2id-custom": p };
}

export interface RegistrationState {
	readonly request: string;
	finish(responseB64: string, email: string, serverIdentity: string, ksfVersion: number): { record: string; exportKey: Uint8Array };
}

export function startRegistration(password: string): RegistrationState {
	const s = opaque.client.startRegistration({ password });
	return {
		request: s.registrationRequest,
		finish(response, email, serverIdentity, ksfVersion) {
			const r = opaque.client.finishRegistration({
				password, clientRegistrationState: s.clientRegistrationState, registrationResponse: response,
				identifiers: { client: email, server: serverIdentity }, keyStretching: keyStretching(ksfVersion),
			});
			return { record: r.registrationRecord, exportKey: fromB64(r.exportKey) };
		},
	};
}

export interface LoginState {
	readonly request: string;
	/** Returns null when the password is wrong (or the server answered for an unknown email). */
	finish(responseB64: string, email: string, serverIdentity: string, ksfVersion: number): { finishRequest: string; exportKey: Uint8Array } | null;
}

export function startLogin(password: string): LoginState {
	const s = opaque.client.startLogin({ password });
	return {
		request: s.startLoginRequest,
		finish(response, email, serverIdentity, ksfVersion) {
			const r = opaque.client.finishLogin({
				password, clientLoginState: s.clientLoginState, loginResponse: response,
				identifiers: { client: email, server: serverIdentity }, keyStretching: keyStretching(ksfVersion),
			});
			if (!r) return null;
			return { finishRequest: r.finishLoginRequest, exportKey: fromB64(r.exportKey) };
		},
	};
}

export const b64 = toB64;
