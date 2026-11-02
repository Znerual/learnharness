// Reference implementation of the vault server routes (#42-#44). `createVaultRoutes(deps)` maps
// each route of the contract to calls on the vault client package. It runs in the LearnHarness
// server process, which owns the Vault object, the key storage and the sync engine. The renderer
// only sees JSON: it never holds keys, root keys, device tokens or re-authentication grants.
//
// What does leave the process, because the learner must see or type it:
// - the recovery key, backup codes and emergency kit, once, right after signup or regeneration;
// - the pairing QR payload and text code (the pairing secret, valid 10 minutes, one key);
// - a passkey PRF output the browser computed during sign-in (the WebAuthn API runs in the
//   renderer; the output is sent once and never stored).
//
// The module imports no runtime code from the client, so it can be tested against a fake Vault
// and does not drag libsodium into anything that merely imports the contract.

import { routeTable, type HttpMethod, type OneTimeSecrets, type ReauthStrength, type RotationDto, type RouteErrorBody, type RouteName, type SessionDto, type VaultContract } from "../../core/vault/contract.ts";
import type { AccountResponse, DeviceRow, EmergencyKit, SyncStatus } from "../../core/vault/deps.ts";
import type { JoinChoice, MergeReport, MigrationStateDto } from "../../core/vault/migration.ts";
import type { PasswordCheckResult } from "../../core/vault/models/password.ts";
import { PasskeyError, type PasskeyPort } from "./passkey-ipc.ts";

export * from "../../core/vault/contract.ts";

// ---------------------------------------------------------------- what the routes need

/** Secret text with the display form the learner copies, like the client's RecoverySecret. */
export interface SecretText {
	display(): string;
}

/** The part of the client's `Vault` the routes call. The real class satisfies it (see compat.ts). */
export interface VaultLike {
	readonly accountId: string;
	readonly deviceId: string;
	readonly ephemeral: boolean;
	mustSetPassword: boolean;
	readonly api: { post<T>(path: string, body: unknown, auth?: unknown): Promise<T> };
	auth(reauth?: string): unknown;
	account(): Promise<AccountResponse>;
	devices(): Promise<DeviceRow[]>;
	renameDevice(id: string, name: string): Promise<void>;
	signOut(): Promise<void>;
	reauthPassword(password: string): Promise<string>;
	reauthRecovery(text: string): Promise<string>;
	reauthPasskeyStart(): Promise<{ ceremonyId: string; options: unknown }>;
	reauthPasskeyFinish(ceremonyId: string, credential: unknown): Promise<string>;
	passkeyRegisterStart(grant: string): Promise<{ ceremonyId: string; options: unknown; prfSalt: Uint8Array }>;
	passkeyRegisterFinish(ceremonyId: string, credential: unknown, name: string, prfOutput: Uint8Array | null, grant: string): Promise<{ passkeyId: string; signInOnly: boolean }>;
	passkeys(): Promise<{ id: string; name: string; signInOnly: boolean; methodId: string | null }[]>;
	removePasskey(passkeyId: string, grant: string): Promise<RotationDto>;
	revokeDevice(deviceId: string, grant: string): Promise<RotationDto>;
	confirmPending(id: string, grant: string): Promise<void>;
	cancelPending(id: string, grant: string): Promise<void>;
	changePassword(newPassword: string, grant: string): Promise<RotationDto>;
	setNewPassword(newPassword: string): Promise<RotationDto>;
	regenerateRecoveryKey(grant: string): Promise<RotationDto & { recoveryKey: SecretText }>;
	regenerateBackupCodes(grant: string): Promise<RotationDto & { backupCodes: SecretText[] }>;
	emergencyKit(email: string, recoveryKey: SecretText): EmergencyKit;
	deleteAccount(grant: string): Promise<void>;
	pairShow(): Promise<{ pairingId: string; qr: string; text: string; secret: Uint8Array }>;
	pairReview(pairingId: string, secret: Uint8Array): Promise<{ name: string; code: string; publicKey: Uint8Array }>;
	pairApprove(pairingId: string, secret: Uint8Array, publicKey: Uint8Array): Promise<void>;
	downloadExport(): Promise<Uint8Array>;
}

export interface JoinerLike {
	readonly pairingId: string;
	readonly code: string;
	readonly qr: string;
	readonly text: string;
	finish(): Promise<VaultLike>;
}

export interface SignupSessionLike {
	email: string;
}

/** Options the routes pass back to the client; opaque to the routes. */
export type VaultOptionsLike = unknown;

/** The static entry points of the client's `Vault` class. */
export interface VaultStatics {
	signupStart(serverUrl: string, email: string): Promise<void>;
	signupVerify(serverUrl: string, email: string, code: string): Promise<SignupSessionLike>;
	signupFinish(o: VaultOptionsLike, s: SignupSessionLike, password: string): Promise<{ vault: VaultLike; display: { recoveryKey: SecretText; backupCodes: SecretText[] }; kit: EmergencyKit }>;
	confirmRecoveryMaterial(display: { recoveryKey: SecretText; backupCodes: SecretText[] }, typed: string): boolean;
	signIn(o: VaultOptionsLike, email: string, password: string): Promise<VaultLike>;
	open(o: VaultOptionsLike): Promise<VaultLike | null>;
	recover(o: VaultOptionsLike, email: string, text: string): Promise<VaultLike>;
	passkeySignInStart(o: VaultOptionsLike, email: string): Promise<{ ceremonyId: string; options: unknown }>;
	passkeySignInFinish(o: VaultOptionsLike, ceremonyId: string, credential: unknown, prfOutput: Uint8Array | null): Promise<{ status: "unlocked"; vault: VaultLike } | { status: "needs_unlock"; session: unknown }>;
	unlockSessionWithPassword(o: VaultOptionsLike, session: unknown, email: string, password: string): Promise<VaultLike>;
	pairShowAsJoiner(o: VaultOptionsLike): Promise<JoinerLike>;
	pairJoin(o: VaultOptionsLike, qr: string): Promise<JoinerLike>;
	/** Reads a `lhv1-pair:` code; a signed-in device uses it for a code the new device shows. */
	parsePairingCode(qrOrText: string): { serverUrl: string; pairingId: string; secret: Uint8Array };
}

/** What a first start on this device would do (see `VaultRouteDeps.sync.plan`). */
export interface StartPlan {
	/** No start has completed for this account on this device yet. */
	firstStart: boolean;
	/** Files in this device's data folder. */
	localFiles: number;
	/** The vault already holds records (only asked when there are local files). */
	vaultHasRecords: boolean;
}

export interface RestorerLike {
	versions(path: string): Promise<{ seq: number; createdAt: string; deviceName: string; deleted: boolean; size: number }[]>;
	restoreVersion(path: string, seq: number): Promise<void>;
	preview(at: Date): Promise<{ path: string; change: "changed" | "added" | "removed" }[]>;
	restoreTo(at: Date): Promise<{ path: string; change: "changed" | "added" | "removed" }[]>;
}

export interface VaultRouteDeps {
	serverUrl: string;
	Vault: VaultStatics;
	/** VaultOptions for this installation (storage, device id and name, ephemeral flag). */
	options: () => VaultOptionsLike;
	/** The client's `checkPassword`, with the fork's offline policy. */
	checkPassword: (password: string) => Promise<PasswordCheckResult>;
	/** The passkey ceremony (the Electron passkey window on desktop). Absent: passkeys are unavailable. */
	passkeys?: PasskeyPort;
	/**
	 * Owns the SyncEngine: started after unlock, stopped on sign-out. `plan` looks at a first start on this device without
	 * changing anything; `start` with `choice: "use-vault"` is the learner's answer to the join question, and without it a
	 * first start never moves local files (it refuses when it would have to).
	 */
	sync: {
		start(vault: VaultLike, o?: { choice?: JoinChoice }): void | Promise<void>;
		stop(): void | Promise<void>;
		status(): SyncStatus;
		syncNow(): Promise<SyncStatus>;
		plan?(vault: VaultLike): Promise<StartPlan>;
	};
	/** Moving local data into the vault (docs/vault-migration.md). Absent: the routes answer 503. */
	migration?: {
		report(): Promise<MigrationStateDto>;
		setAsideSyncthing(): Promise<{ moved: string[]; remaining: string[] }>;
		merge(name: string): Promise<MergeReport>;
	};
	restorer: (vault: VaultLike) => RestorerLike;
	/** The client's `leaveVault(dataDir, storage, opts)`, bound to this installation. */
	leaveVault: (opts: { dryRun?: boolean }) => Promise<{ unpushed: number }>;
	/** Local setting "Remind me to export every 90 days" (default on). */
	exportReminder: { get(): boolean | Promise<boolean>; set(enabled: boolean): void | Promise<void> };
	now?: () => number;
	randomId?: () => string;
}

// ---------------------------------------------------------------- errors

export class RouteError extends Error {
	constructor(readonly status: number, readonly code: string, message?: string) {
		super(message ?? code);
		this.name = "RouteError";
	}
}

/** Maps client errors to HTTP status and a stable code. Unknown errors become 500 `internal`. */
export function toRouteError(e: unknown): RouteError {
	if (e instanceof RouteError) return e;
	const x = e as { name?: string; status?: number; code?: string; message?: string; body?: Record<string, unknown> };
	if (x?.name === "ApiError" && typeof x.status === "number" && typeof x.code === "string") {
		const msg = typeof x.body?.["message"] === "string" ? (x.body["message"] as string) : x.code;
		return new RouteError(x.status, x.code, msg);
	}
	if (e instanceof PasskeyError) {
		const status = e.code === "passkey_unavailable" ? 503 : e.code === "passkey_failed" ? 502 : 409;
		return new RouteError(status, e.code, e.message);
	}
	if (x?.name === "SyncthingFolderError") return new RouteError(409, "syncthing_folder", x.message);
	if (x?.name === "MigrationRefusedError") return new RouteError(409, "data_newer", x.message);
	if (x?.name === "JoinChoiceRequiredError") return new RouteError(409, "join_choice_required", x.message);
	if (x?.name === "NetworkError") return new RouteError(503, "network", "The vault server is not reachable");
	if (x?.name === "VaultError" && typeof x.code === "string") {
		const status = x.code === "signed_out" || x.code === "login_failed" ? 401 : x.code.startsWith("password_") ? 422 : x.code === "pairing_timeout" ? 408 : x.code === "pairing_cancelled" ? 409 : 400;
		return new RouteError(status, x.code, x.message);
	}
	return new RouteError(500, "internal", "Unexpected error");
}

// ---------------------------------------------------------------- request helpers

function str(req: object, key: string): string {
	const v = (req as Record<string, unknown>)[key];
	if (typeof v !== "string" || v === "") throw new RouteError(400, "bad_request", `${key} is required`);
	return v;
}

function bool(req: object, key: string): boolean {
	const v = (req as Record<string, unknown>)[key];
	if (typeof v !== "boolean") throw new RouteError(400, "bad_request", `${key} must be true or false`);
	return v;
}

function parseAt(req: object): Date {
	const d = new Date(str(req, "at"));
	if (Number.isNaN(d.getTime())) throw new RouteError(400, "bad_request", "at must be an ISO time");
	return d;
}

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------- routes

export type Handlers = { [K in RouteName]: (req: VaultContract[K]["req"]) => Promise<VaultContract[K]["res"]> };

export interface RouteRequest {
	method: string;
	/** Path relative to the mount point, without query. */
	path: string;
	query?: Record<string, string>;
	body?: unknown;
}

export interface RouteResponse {
	status: number;
	body: unknown;
}

export interface VaultRoutes {
	handlers: Handlers;
	/** Framework-agnostic dispatcher: the fork's catch-all route calls this. */
	handle(req: RouteRequest): Promise<RouteResponse>;
	/** The vault the routes currently hold, for the fork's own server code (sync engine, restorer). */
	currentVault(): VaultLike | null;
}

const GRANT_TTL_MS = 5 * 60_000;

export function createVaultRoutes(deps: VaultRouteDeps): VaultRoutes {
	const now = deps.now ?? (() => Date.now());
	let counter = 0;
	const newId = deps.randomId ?? (() => `h${(++counter).toString(36)}${Math.random().toString(36).slice(2, 10)}`);

	let vault: VaultLike | null = null;
	let signup: { session: SignupSessionLike; display?: { recoveryKey: SecretText; backupCodes: SecretText[] } } | null = null;
	let lockedSession: { session: unknown; email: string } | null = null;
	/** Signed in, waiting for the learner before the first sync starts (the "joining" session). */
	let joining: { email: string; localFiles: number } | null = null;
	const grants = new Map<string, { grant: string; expires: number }>();
	const passkeyPort: PasskeyPort = deps.passkeys ?? {
		availability: () => ({ available: false, reason: "bridge_missing" }),
		create: () => Promise.reject(new PasskeyError("passkey_unavailable")),
		get: () => Promise.reject(new PasskeyError("passkey_unavailable")),
	};
	const approvals = new Map<string, { secret: Uint8Array; publicKey?: Uint8Array }>();
	const joiners = new Map<string, JoinerLike>();

	function needVault(): VaultLike {
		if (!vault) throw new RouteError(401, "no_session", "Not signed in");
		return vault;
	}

	function needMigration(): NonNullable<VaultRouteDeps["migration"]> {
		if (!deps.migration) throw new RouteError(503, "vault_unavailable", "Moving data is not available here");
		return deps.migration;
	}

	function sessionDto(): SessionDto {
		if (vault?.mustSetPassword) return { state: "must_set_password" };
		if (vault && joining) return { state: "joining", email: joining.email, localFiles: joining.localFiles };
		if (vault) return { state: "signed_in", accountId: vault.accountId, deviceId: vault.deviceId, ephemeral: vault.ephemeral, offline: deps.sync.status().state === "offline" };
		if (lockedSession) return { state: "needs_unlock", email: lockedSession.email };
		return { state: "signed_out" };
	}

	/** Starts the sync, or, on a first start that needs the learner, waits for `joinConfirm` (nothing moves before). */
	async function begin(v: VaultLike, o: { announce?: boolean } = {}): Promise<void> {
		let plan: StartPlan | null = null;
		try {
			plan = (await deps.sync.plan?.(v)) ?? null;
		} catch {
			// offline: the start itself decides (it never moves files without the learner's choice)
		}
		const ask = plan !== null && plan.firstStart && plan.localFiles > 0 && plan.vaultHasRecords;
		if (plan && plan.firstStart && (ask || o.announce)) {
			const email = await v.account().then((a) => a.email, () => "");
			joining = { email, localFiles: ask ? plan.localFiles : 0 };
			return;
		}
		await deps.sync.start(v);
	}

	async function adopt(v: VaultLike, o: { announce?: boolean } = {}): Promise<SessionDto> {
		vault = v;
		lockedSession = null;
		joining = null;
		if (!v.mustSetPassword) await begin(v, o);
		return sessionDto();
	}

	/** Forgets the session after the vault and the sync were stopped. */
	function forget(): void {
		vault = null;
		joining = null;
		grants.clear();
	}

	function keep(grant: string, strength: ReauthStrength): { reauthId: string; strength: ReauthStrength } {
		const id = newId();
		grants.set(id, { grant, expires: now() + GRANT_TTL_MS });
		return { reauthId: id, strength };
	}

	/** A grant is single-use, even if the action then fails. */
	function takeGrant(id: string): string {
		const g = grants.get(id);
		grants.delete(id);
		if (!g || g.expires < now()) throw new RouteError(403, "reauth_required", "Confirm it is you first");
		return g.grant;
	}

	const handlers: Handlers = {
		// session and launch
		async session() {
			return sessionDto();
		},
		async open() {
			if (vault) return sessionDto();
			const v = await deps.Vault.open(deps.options());
			return v ? adopt(v) : sessionDto();
		},
		async signOut() {
			const v = needVault();
			await deps.sync.stop();
			try {
				await v.signOut();
			} finally {
				forget();
			}
			return {};
		},
		async joinConfirm(req) {
			const v = needVault();
			if (!joining) throw new RouteError(409, "bad_request", "There is nothing to confirm");
			const choice = (req as { choice?: unknown }).choice;
			if (choice === "cancel") {
				await deps.sync.stop();
				try {
					await v.signOut();
				} finally {
					forget();
				}
				return sessionDto();
			}
			if (choice !== "use-vault" && choice !== "merge") throw new RouteError(400, "bad_request", "choice must be use-vault, merge or cancel");
			await deps.sync.start(v, { choice });
			joining = null;
			return sessionDto();
		},
		async leaveVault(req) {
			const dry = req.dryRun === true;
			if (!dry) await deps.sync.stop();
			const r = await deps.leaveVault({ dryRun: dry });
			if (!dry) forget();
			return r;
		},

		// sign-up
		async passwordCheck(req) {
			return deps.checkPassword(str(req, "password"));
		},
		async signupStart(req) {
			await deps.Vault.signupStart(deps.serverUrl, str(req, "email"));
			return {};
		},
		async signupVerify(req) {
			signup = { session: await deps.Vault.signupVerify(deps.serverUrl, str(req, "email"), str(req, "code")) };
			return {};
		},
		async signupFinish(req) {
			if (!signup) throw new RouteError(409, "bad_request", "Verify the email address first");
			const r = await deps.Vault.signupFinish(deps.options(), signup.session, str(req, "password"));
			signup.display = r.display;
			await adopt(r.vault);
			const display: OneTimeSecrets = { recoveryKey: r.display.recoveryKey.display(), backupCodes: r.display.backupCodes.map((c) => c.display()) };
			return { display, kit: r.kit };
		},
		async signupConfirm(req) {
			if (!signup?.display) throw new RouteError(409, "bad_request", "There is nothing to confirm");
			const ok = deps.Vault.confirmRecoveryMaterial(signup.display, str(req, "typed"));
			if (ok) signup = null; // the secrets leave server memory once the learner proved they saved them
			return { ok };
		},

		// sign-in, unlock, recovery
		async signIn(req) {
			return adopt(await deps.Vault.signIn(deps.options(), str(req, "email"), str(req, "password")));
		},
		async passkeySignIn(req) {
			const email = str(req, "email");
			if (!passkeyPort.availability().available) throw new PasskeyError("passkey_unavailable");
			const start = await deps.Vault.passkeySignInStart(deps.options(), email);
			const c = await passkeyPort.get(start.options);
			// with a PRF output the vault unlocks; without one the session needs another unlock method
			const r = await deps.Vault.passkeySignInFinish(deps.options(), start.ceremonyId, c.credential, c.prfOutput);
			if (r.status === "unlocked") return adopt(r.vault);
			lockedSession = { session: r.session, email: email.trim().toLowerCase() };
			return sessionDto();
		},
		async unlockWithPassword(req) {
			if (!lockedSession) throw new RouteError(409, "bad_request", "There is no signed-in session to unlock");
			const v = await deps.Vault.unlockSessionWithPassword(deps.options(), lockedSession.session, lockedSession.email, str(req, "password"));
			return adopt(v);
		},
		async recover(req) {
			const v = await deps.Vault.recover(deps.options(), str(req, "email"), str(req, "secret"));
			return adopt(v);
		},
		async setNewPassword(req) {
			const v = needVault();
			const out = await v.setNewPassword(str(req, "password"));
			v.mustSetPassword = false;
			await begin(v);
			return out;
		},

		// re-authentication
		async reauthPassword(req) {
			return keep(await needVault().reauthPassword(str(req, "password")), "password");
		},
		async reauthRecovery(req) {
			return keep(await needVault().reauthRecovery(str(req, "secret")), "recovery");
		},
		async reauthPasskey() {
			const v = needVault();
			const start = await v.reauthPasskeyStart();
			const c = await passkeyPort.get(start.options);
			return keep(await v.reauthPasskeyFinish(start.ceremonyId, c.credential), "passkey");
		},

		// account
		async account() {
			const a = await needVault().account();
			return { ...a, passkeyUsable: a.passkeys > 0 && passkeyPort.availability().available };
		},
		async changePassword(req) {
			return needVault().changePassword(str(req, "password"), takeGrant(str(req, "reauthId")));
		},
		async regenerateRecoveryKey(req) {
			const v = needVault();
			const { recoveryKey, ...rotation } = await v.regenerateRecoveryKey(takeGrant(str(req, "reauthId")));
			const email = (await v.account()).email;
			return { rotation: rotation as RotationDto, recoveryKey: recoveryKey.display(), kit: v.emergencyKit(email, recoveryKey) };
		},
		async regenerateBackupCodes(req) {
			const { backupCodes, ...rotation } = await needVault().regenerateBackupCodes(takeGrant(str(req, "reauthId")));
			return { rotation: rotation as RotationDto, backupCodes: backupCodes.map((c) => c.display()) };
		},
		async managePlan() {
			const v = needVault();
			return v.api.post<{ url: string }>("/v1/billing/link", {}, v.auth());
		},
		async deleteAccount(req) {
			const v = needVault();
			const email = (await v.account()).email;
			if (str(req, "email").trim().toLowerCase() !== email.toLowerCase()) throw new RouteError(400, "bad_request", "That is not the email address of this account");
			await v.deleteAccount(takeGrant(str(req, "reauthId")));
			await deps.sync.stop();
			forget();
			return {};
		},

		// passkeys
		async passkeyAvailability() {
			return passkeyPort.availability();
		},
		async passkeys() {
			const rows = await needVault().passkeys();
			return { availability: passkeyPort.availability(), passkeys: rows.map((p) => ({ id: p.id, name: p.name, signInOnly: p.signInOnly })) };
		},
		async passkeyRegister(req) {
			const v = needVault();
			const name = str(req, "name").trim().slice(0, 64);
			if (!name) throw new RouteError(400, "bad_request", "name is required");
			if (!passkeyPort.availability().available) throw new PasskeyError("passkey_unavailable");
			// one grant covers both calls of the registration
			const grant = takeGrant(str(req, "reauthId"));
			const start = await v.passkeyRegisterStart(grant);
			const c = await passkeyPort.create(start.options, start.prfSalt);
			const done = await v.passkeyRegisterFinish(start.ceremonyId, c.credential, name, c.prfOutput, grant);
			return { id: done.passkeyId, name, signInOnly: done.signInOnly };
		},
		async passkeyRemove(req) {
			return needVault().removePasskey(str(req, "passkeyId"), takeGrant(str(req, "reauthId")));
		},

		// devices
		async devices() {
			const v = needVault();
			const [devices, account] = await Promise.all([v.devices(), v.account()]);
			return { devices, pendingAction: account.pendingAction };
		},
		async renameDevice(req) {
			await needVault().renameDevice(str(req, "deviceId"), str(req, "name"));
			return {};
		},
		async revokeDevice(req) {
			const v = needVault();
			const id = str(req, "deviceId");
			if (id === v.deviceId) throw new RouteError(400, "bad_request", "Use sign out for this device");
			return v.revokeDevice(id, takeGrant(str(req, "reauthId")));
		},
		async confirmPending(req) {
			await needVault().confirmPending(str(req, "id"), takeGrant(str(req, "reauthId")));
			return {};
		},
		async cancelPending(req) {
			await needVault().cancelPending(str(req, "id"), takeGrant(str(req, "reauthId")));
			return {};
		},

		// pairing
		async pairShow() {
			const p = await needVault().pairShow();
			approvals.set(p.pairingId, { secret: p.secret });
			return { pairingId: p.pairingId, qr: p.qr, text: p.text };
		},
		async pairReview(req) {
			const v = needVault();
			const id = str(req, "pairingId");
			const a = approvals.get(id);
			if (!a) throw new RouteError(404, "bad_request", "Unknown pairing");
			const r = await v.pairReview(id, a.secret);
			a.publicKey = r.publicKey;
			return { name: r.name, code: r.code };
		},
		async pairApprove(req) {
			const v = needVault();
			const id = str(req, "pairingId");
			const a = approvals.get(id);
			if (!a?.publicKey) throw new RouteError(409, "bad_request", "Review the new device first");
			await v.pairApprove(id, a.secret, a.publicKey);
			approvals.delete(id);
			return {};
		},
		async pairApproverScan(req) {
			needVault();
			const code = str(req, "code").trim();
			if (!code.startsWith("lhv1-pair:")) throw new RouteError(400, "bad_code", "Scan the code the new device shows");
			const p = deps.Vault.parsePairingCode(code);
			if (p.serverUrl.replace(/\/+$/, "") !== deps.serverUrl.replace(/\/+$/, "")) throw new RouteError(400, "bad_code", "This pairing code is for another vault server");
			approvals.set(p.pairingId, { secret: p.secret });
			return { pairingId: p.pairingId };
		},
		async pairCancel(req) {
			approvals.delete(str(req, "pairingId"));
			joiners.delete(str(req, "pairingId"));
			return {};
		},
		async pairJoinerShow() {
			const j = await deps.Vault.pairShowAsJoiner(deps.options());
			joiners.set(j.pairingId, j);
			return { pairingId: j.pairingId, qr: j.qr, text: j.text, code: j.code };
		},
		async pairJoin(req) {
			const j = await deps.Vault.pairJoin(deps.options(), str(req, "code").trim());
			joiners.set(j.pairingId, j);
			return { pairingId: j.pairingId, code: j.code };
		},
		async pairFinish(req) {
			const id = str(req, "pairingId");
			const j = joiners.get(id);
			if (!j) throw new RouteError(404, "bad_request", "Unknown pairing");
			const v = await j.finish();
			joiners.delete(id);
			// a new device always gets the "Joining the vault of ..." screen before it syncs
			return adopt(v, { announce: true });
		},

		// moving local data into the vault
		async migrationReport() {
			return needMigration().report();
		},
		async migrationSyncthingSetAside(req) {
			if ((req as { confirmed?: unknown }).confirmed !== true) throw new RouteError(400, "bad_request", "confirmed must be true");
			return needMigration().setAsideSyncthing();
		},
		async migrationMerge(req) {
			needVault();
			return needMigration().merge(str(req, "name"));
		},

		// sync
		async syncStatus() {
			return deps.sync.status();
		},
		async syncNow() {
			needVault();
			return deps.sync.syncNow();
		},

		// history
		async historyVersions(req) {
			return { versions: await deps.restorer(needVault()).versions(str(req, "path")) };
		},
		async historyRestoreVersion(req) {
			const seq = Number(req.seq);
			if (!Number.isInteger(seq)) throw new RouteError(400, "bad_request", "seq must be an integer");
			await deps.restorer(needVault()).restoreVersion(str(req, "path"), seq);
			return {};
		},
		async historyPreview(req) {
			return { plan: (await deps.restorer(needVault()).preview(parseAt(req))).map((p) => ({ path: p.path, change: p.change })) };
		},
		async historyRestoreTo(req) {
			return { plan: (await deps.restorer(needVault()).restoreTo(parseAt(req))).map((p) => ({ path: p.path, change: p.change })) };
		},

		// export
		async exportDownload() {
			const bytes = await needVault().downloadExport();
			const d = new Date(now()).toISOString().slice(0, 10).replace(/-/g, "");
			return { filename: `lhv-export-${d}.tar`, contentType: "application/x-tar", dataBase64: toBase64(bytes) };
		},
		async exportReminderGet() {
			return { enabled: await deps.exportReminder.get() };
		},
		async exportReminderSet(req) {
			const enabled = bool(req, "enabled");
			await deps.exportReminder.set(enabled);
			return { enabled };
		},
	};

	// path matching, literal segments before parameters
	const table = (Object.keys(routeTable) as RouteName[])
		.map((name) => {
			const { method, path } = routeTable[name];
			const segs = path.split("/").filter(Boolean);
			return { name, method, segs, params: segs.filter((s) => s.startsWith(":")).length };
		})
		.sort((a, b) => a.params - b.params);

	function match(method: string, path: string): { name: RouteName; params: Record<string, string> } | "method" | null {
		const parts = path.split("/").filter(Boolean);
		let pathHit = false;
		for (const r of table) {
			if (r.segs.length !== parts.length) continue;
			const params: Record<string, string> = {};
			let ok = true;
			r.segs.forEach((s, i) => {
				const p = parts[i] as string;
				if (s.startsWith(":")) params[s.slice(1)] = decodeURIComponent(p);
				else if (s !== p) ok = false;
			});
			if (!ok) continue;
			pathHit = true;
			if (r.method === (method.toUpperCase() as HttpMethod)) return { name: r.name, params };
		}
		return pathHit ? "method" : null;
	}

	async function handle(req: RouteRequest): Promise<RouteResponse> {
		const m = match(req.method, req.path);
		const fail = (e: RouteError): RouteResponse => ({ status: e.status, body: { error: e.code, message: e.message } satisfies RouteErrorBody });
		if (m === null) return fail(new RouteError(404, "not_found", "Unknown route"));
		if (m === "method") return fail(new RouteError(405, "method_not_allowed", "Method not allowed"));
		try {
			const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
			const input = { ...(req.query ?? {}), ...body, ...m.params };
			const out = await (handlers[m.name] as (r: object) => Promise<unknown>)(input);
			return { status: 200, body: out };
		} catch (e) {
			return fail(toRouteError(e));
		}
	}

	return { handlers, handle, currentVault: () => vault };
}
