// Server-process side of the `lh:passkey` bridge (ADR 0004): the passkey ceremony over the
// inherited Node child IPC channel to the Electron main process (electron/passkey-window.cjs),
// which runs it in its own window on https://vault.<domain>. The request, the credential and the
// PRF output travel server child <-> main only; the UI renderer never sees them. No imports from
// the vault client, so routes.ts and its tests stay free of it.

import type { IpcProcess } from "./keystorage-ipc.ts";

export const CHANNEL = "lh:passkey";

/** The PRF salt of an unlock passkey (`PASSKEY_PRF_SALT` of the vault client, which does not export it). */
export const PASSKEY_PRF_SALT = "lhv1/unlock/passkey";

export type PasskeyUnavailableReason = "bridge_missing" | "unsupported_server";

export type PasskeyAvailability = { available: true } | { available: false; reason: PasskeyUnavailableReason };

/** What one ceremony returns: the credential (PRF results already stripped) and the PRF output, if the key has one. */
export interface CeremonyOutcome {
	credential: unknown;
	prfOutput: Uint8Array | null;
	prfEnabled: boolean;
}

/** The port the routes use. `create` is the registration ceremony, `get` an assertion (sign-in, re-authentication). */
export interface PasskeyPort {
	availability(): PasskeyAvailability;
	create(options: unknown, prfSalt: Uint8Array): Promise<CeremonyOutcome>;
	get(options: unknown, prfSalt?: Uint8Array): Promise<CeremonyOutcome>;
}

/** A ceremony that did not produce a credential. `code` is a route error code (strings.errors). */
export class PasskeyError extends Error {
	constructor(readonly code: "passkey_cancelled" | "passkey_busy" | "passkey_unavailable" | "passkey_failed", message?: string) {
		super(message ?? code);
		this.name = "PasskeyError";
	}
}

/**
 * The relying party domain of a vault server URL, `vault.<domain>`, or null when the desktop
 * ceremony window cannot serve it. The same rule as `passkeyDomain` in electron/passkey-window.cjs
 * (tests/vault-passkey-window.test.ts keeps them equal).
 */
export function passkeyDomain(vaultUrl: string): string | null {
	let u: URL;
	try {
		u = new URL(vaultUrl);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" || u.port !== "") return null;
	const m = /^vault\.((?:[a-z0-9-]+\.)+[a-z0-9-]+)$/.exec(u.hostname);
	return m ? (m[1] as string) : null;
}

export interface IpcPasskeysOptions {
	proc?: IpcProcess;
	/** Longer than the window's own timeout (120 s), so the window answers first. */
	timeoutMs?: number;
	/** True when this process is the desktop app's own server child (LH_DESKTOP_SERVER). */
	desktop?: boolean;
	/** The configured vault server URL. */
	serverUrl?: string | null;
}

type Pending = { resolve: (v: CeremonyOutcome) => void; reject: (e: PasskeyError) => void; timer: NodeJS.Timeout };

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** Passkey ceremonies through the Electron main process; unavailable anywhere else (web/dev, Android). */
export class IpcPasskeys implements PasskeyPort {
	private readonly proc: IpcProcess;
	private readonly timeoutMs: number;
	private readonly desktop: boolean;
	private readonly serverUrl: string | null;
	private readonly pending = new Map<string, Pending>();
	private seq = 0;
	private attached = false;

	constructor(o: IpcPasskeysOptions = {}) {
		this.proc = o.proc ?? (process as unknown as IpcProcess);
		this.timeoutMs = o.timeoutMs ?? 150_000;
		this.desktop = o.desktop ?? process.env.LH_DESKTOP_SERVER === "1";
		this.serverUrl = o.serverUrl ?? null;
	}

	private get hasBridge(): boolean {
		return this.desktop && typeof this.proc.send === "function" && this.proc.connected === true;
	}

	availability(): PasskeyAvailability {
		if (!this.hasBridge) return { available: false, reason: "bridge_missing" };
		if (this.serverUrl === null || passkeyDomain(this.serverUrl) === null) return { available: false, reason: "unsupported_server" };
		return { available: true };
	}

	create(options: unknown, prfSalt: Uint8Array): Promise<CeremonyOutcome> {
		return this.call("create", options, prfSalt);
	}

	get(options: unknown, prfSalt: Uint8Array = new TextEncoder().encode(PASSKEY_PRF_SALT)): Promise<CeremonyOutcome> {
		return this.call("get", options, prfSalt);
	}

	private call(op: "create" | "get", options: unknown, prfSalt: Uint8Array): Promise<CeremonyOutcome> {
		if (!this.availability().available) return Promise.reject(new PasskeyError("passkey_unavailable"));
		this.attach();
		const id = `pk-${process.pid}-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new PasskeyError("passkey_failed", "the passkey ceremony timed out"));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.proc.send!({ channel: CHANNEL, id, op, options, prfSalt: b64u(prfSalt) }, (err) => {
					if (err) this.settle(id, (p) => p.reject(new PasskeyError("passkey_failed", err.message)));
				});
			} catch (e) {
				this.settle(id, (p) => p.reject(new PasskeyError("passkey_failed", (e as Error).message)));
			}
		});
	}

	private settle(id: string, fn: (p: Pending) => void): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		fn(p);
	}

	private attach(): void {
		if (this.attached) return;
		this.attached = true;
		this.proc.on("message", (m: unknown) => this.onMessage(m));
		this.proc.on("disconnect", () => {
			for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(new PasskeyError("passkey_failed", "IPC channel closed")));
		});
	}

	private onMessage(m: unknown): void {
		const msg = m as { channel?: unknown; id?: unknown; ok?: unknown; value?: { credential?: unknown; prfOutput?: unknown; prfEnabled?: unknown }; error?: { name?: unknown; message?: unknown } };
		if (!msg || msg.channel !== CHANNEL || typeof msg.id !== "string") return;
		this.settle(msg.id, (p) => {
			if (msg.ok === true && msg.value && typeof msg.value === "object") {
				const prf = typeof msg.value.prfOutput === "string" ? new Uint8Array(Buffer.from(msg.value.prfOutput, "base64url")) : null;
				if (prf !== null && prf.length !== 32) return p.reject(new PasskeyError("passkey_failed", "the PRF output is not 32 bytes"));
				return p.resolve({ credential: msg.value.credential, prfOutput: prf, prfEnabled: msg.value.prfEnabled === true || prf !== null });
			}
			const name = typeof msg.error?.name === "string" ? msg.error.name : "";
			const message = typeof msg.error?.message === "string" ? msg.error.message : name;
			// the learner closed the window, dismissed the prompt or no authenticator answered
			if (name === "NotAllowedError" || name === "AbortError") return p.reject(new PasskeyError("passkey_cancelled", message));
			if (name === "Busy") return p.reject(new PasskeyError("passkey_busy", message));
			return p.reject(new PasskeyError("passkey_failed", message));
		});
	}
}
