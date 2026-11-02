// Node side of the Android passkey bridge (vault ADR 0004 "Android"). The Kotlin shell runs the
// ceremony with Credential Manager (PasskeyBridge.kt in learnharness-vault integration/android)
// and serves it on its loopback KeystoreServer, whose URL it passes as LH_PASSKEY_URL on Android 9
// or newer; the bearer is the per-launch LH_DESKTOP_API_SECRET. The request, the credential and the
// PRF output stay inside the app process; the WebView page never sees them.
//
//   POST /passkey/create, /passkey/get  {"options", "prfSalt": base64url}
//   -> 200 {"ok":true,"credential","prfOutput":base64url|null,"prfEnabled"} | {"ok":false,"error":{"name","message"}}
//
// The RP id is the host of the vault server URL. Credential Manager allows it only when that host
// serves /.well-known/assetlinks.json for this app (the vault server does, from LHV_ANDROID_CERT_SHA256).

import { PASSKEY_PRF_SALT, PasskeyError, type CeremonyOutcome, type PasskeyAvailability, type PasskeyPort } from "./passkey-ipc.ts";

export interface AndroidPasskeysOptions {
	/** LH_PASSKEY_URL; undefined when the shell has no passkey bridge. */
	url: string | undefined;
	/** LH_DESKTOP_API_SECRET */
	secret: string | undefined;
	/** The configured vault server URL. */
	serverUrl: string | null;
	/** Longer than the shell's own prompt timeout (120 s), so the shell answers first. */
	timeoutMs?: number;
	fetch?: typeof fetch;
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const B64URL = /^[A-Za-z0-9_-]*$/;

/** Passkey ceremonies through the Android shell's Credential Manager bridge. */
export class AndroidPasskeys implements PasskeyPort {
	private readonly o: AndroidPasskeysOptions;
	constructor(o: AndroidPasskeysOptions) {
		this.o = o;
	}

	static fromEnv(env: Readonly<Record<string, string | undefined>>, serverUrl: string | null): AndroidPasskeys {
		return new AndroidPasskeys({ url: env["LH_PASSKEY_URL"], secret: env["LH_DESKTOP_API_SECRET"], serverUrl });
	}

	availability(): PasskeyAvailability {
		if (!this.o.url || !this.o.secret) return { available: false, reason: "bridge_missing" };
		if (!rpHost(this.o.serverUrl)) return { available: false, reason: "unsupported_server" };
		return { available: true };
	}

	create(options: unknown, prfSalt: Uint8Array): Promise<CeremonyOutcome> {
		return this.call("create", options, prfSalt);
	}

	get(options: unknown, prfSalt: Uint8Array = new TextEncoder().encode(PASSKEY_PRF_SALT)): Promise<CeremonyOutcome> {
		return this.call("get", options, prfSalt);
	}

	private async call(op: "create" | "get", options: unknown, prfSalt: Uint8Array): Promise<CeremonyOutcome> {
		if (!this.availability().available) throw new PasskeyError("passkey_unavailable");
		const f = this.o.fetch ?? fetch;
		let res: Response;
		try {
			res = await f(`${this.o.url}/passkey/${op}`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.o.secret}`, "content-type": "application/json" },
				body: JSON.stringify({ options, prfSalt: b64u(prfSalt) }),
				signal: AbortSignal.timeout(this.o.timeoutMs ?? 150_000),
			});
		} catch (e) {
			throw new PasskeyError("passkey_failed", (e as Error).message);
		}
		if (res.status === 404) throw new PasskeyError("passkey_unavailable");
		if (!res.ok) throw new PasskeyError("passkey_failed", `passkey bridge answered ${res.status}`);
		const r = (await res.json().catch(() => null)) as BridgeReply | null;
		return outcome(r);
	}
}

type BridgeReply = { ok?: unknown; credential?: unknown; prfOutput?: unknown; prfEnabled?: unknown; error?: { name?: unknown; message?: unknown } };

/** Checks the shell's reply and turns it into a ceremony outcome; exported for tests. */
export function outcome(r: BridgeReply | null): CeremonyOutcome {
	if (!r || typeof r !== "object") throw new PasskeyError("passkey_failed", "the passkey bridge sent no JSON");
	if (r.ok !== true) {
		const name = typeof r.error?.name === "string" ? r.error.name : "";
		const message = typeof r.error?.message === "string" ? r.error.message : name;
		// the learner dismissed the prompt or has no passkey for this account on the phone
		if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyError("passkey_cancelled", message);
		if (name === "Busy") throw new PasskeyError("passkey_busy", message);
		throw new PasskeyError("passkey_failed", message || "the passkey ceremony failed");
	}
	const c = r.credential as { type?: unknown; id?: unknown; rawId?: unknown; response?: { clientDataJSON?: unknown }; clientExtensionResults?: Record<string, unknown> } | null;
	if (!c || typeof c !== "object" || c.type !== "public-key" || typeof c.id !== "string" || typeof c.rawId !== "string" || typeof c.response?.clientDataJSON !== "string") {
		throw new PasskeyError("passkey_failed", "the passkey bridge sent no credential");
	}
	let prf: Uint8Array | null = null;
	if (r.prfOutput !== null && r.prfOutput !== undefined) {
		if (typeof r.prfOutput !== "string" || !B64URL.test(r.prfOutput)) throw new PasskeyError("passkey_failed", "bad PRF output");
		prf = new Uint8Array(Buffer.from(r.prfOutput, "base64url"));
		if (prf.length !== 32) throw new PasskeyError("passkey_failed", "the PRF output is not 32 bytes");
	}
	const prfEnabled = r.prfEnabled === true || prf !== null;
	// Defence in depth: the PRF output is a secret and never goes to the vault server.
	const credential = { ...c } as Record<string, unknown>;
	const ext = c.clientExtensionResults;
	if (ext && typeof ext === "object") {
		const { prf: _prf, ...rest } = ext;
		credential.clientExtensionResults = _prf !== undefined ? { ...rest, prf: { enabled: prfEnabled } } : rest;
	}
	return { credential, prfOutput: prf, prfEnabled };
}

/** The RP id host of a vault server URL (https only), or null. */
function rpHost(serverUrl: string | null): string | null {
	if (!serverUrl) return null;
	try {
		const u = new URL(serverUrl);
		return u.protocol === "https:" && u.hostname ? u.hostname : null;
	} catch {
		return null;
	}
}
