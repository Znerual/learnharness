// Account flows of the client package (#28, #29, #30, #32, #33): signup, sign-in, unlock,
// recovery, re-authentication, rotation, devices, pairing and passkeys. The renderer never
// sees keys; this runs in the LearnHarness server process.

import { ApiClient, ApiError, b64, unb64 } from "./api/client.ts";
import type { AccountResponse, DeviceInput, DeviceRow, GrantResponse, KeysResponse, MethodRow, PendingAction, SignInResponse } from "./api/types.ts";
import {
	acceptRotation, approveTag, boxKeyPairFromSeed, buildRotation, bytesEqual, checkDeviceName, commitment, confirmationCode, createMethod,
	currentEpoch, decodePairingQr, decodePairingText, encodePairingQr, encodePairingText, generateBackupCodes, generatePairingSecret,
	generateRecoveryKey, joinTag, fromUtf8, sodium, type KeySet, type MethodForSeal, type MethodKind, newAccountKeys, openRootKey, parseRecoverySecret,
	passkeySeed, passwordSeed, pkTag, ProtocolError, randomBytes, type RecoverySecret, recoveryMaterial, sealRootKey, signRecoveryChallenge,
	unlock, unwrapAll, verifyApproveTag, verifyJoinTag, verifyPkTag, type Wrap, wrapAllKeys, guessRecoveryKind, ACCOUNT_SALT_BYTES,
} from "./crypto/index.ts";
import { MemoryKeyStorage, type KeyStorage, type SecretBundle } from "./keystorage.ts";
import { checkPassword, type PasswordCheckOptions } from "./passwords.ts";
import { CURRENT_KSF_VERSION, startLogin, startRegistration } from "./opaque.ts";

export interface DeviceInfo {
	/** LearnHarness device id, dev_xxxxxxxx. */
	lhDeviceId: string;
	name: string;
}

export interface VaultOptions {
	serverUrl: string;
	storage: KeyStorage;
	device: DeviceInfo;
	/** Session mode (no secure storage): no device unlock method, token expires 24 h after last use. */
	ephemeral?: boolean;
	/** The bundle is stored unprotected (opt-in); shown as "keys not protected". */
	keysProtected?: boolean;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	password?: PasswordCheckOptions;
	/**
	 * Asked before a rotation seals to methods this device has not verified before (ADR 0002 rule 5).
	 * Required for rotations: when missing, a rotation that would seal to a new method fails with
	 * `methods_not_confirmed` (fail closed).
	 */
	confirmNewMethods?: (methods: MethodRow[]) => Promise<boolean>;
}

export class VaultError extends Error {
	readonly code: string;
	/** Method ids the error is about (unverified_methods, server_kept_consumed_method). */
	readonly methodIds: readonly string[];
	constructor(code: string, message: string, methodIds: readonly string[] = []) {
		super(message);
		this.name = "VaultError";
		this.code = code;
		this.methodIds = methodIds;
	}
}

/** A method row the server lists that this device refuses to pin or seal to. */
export interface UnverifiedMethod {
	id: string;
	kind: MethodKind;
	reason: "pk_tag_mismatch" | "pin_mismatch" | "consumed";
}

/** What the learner must see exactly once after signup or regeneration. */
export interface RecoveryMaterialDisplay {
	recoveryKey?: RecoverySecret;
	backupCodes?: RecoverySecret[];
}

/** Content of the emergency kit PDF the UI renders (ADR 0005). Never uploaded. */
export interface EmergencyKit {
	email: string;
	serverUrl: string;
	recoveryKey: string;
	/** QR payload for the recovery key. */
	recoveryKeyQr: string;
	createdAt: string;
}

export type RotationOutcome = { status: "applied"; generation: number } | { status: "pending"; pendingAction: PendingAction };

/**
 * Passwords are normalized to NFC before OPAQUE so the same text typed on different platforms
 * gives the same key. Beta accounts created with the raw string still sign in: NFC first, then raw.
 */
function passwordVariants(password: string): string[] {
	const nfc = password.normalize("NFC");
	return nfc === password ? [nfc] : [nfc, password];
}

function deviceInput(o: VaultOptions): DeviceInput {
	return { lhDeviceId: o.device.lhDeviceId, name: checkDeviceName(o.device.name), ephemeral: !!o.ephemeral, keysProtected: o.keysProtected ?? true };
}

function wrapsFrom(rows: { name: string; wrap: string }[]): Wrap[] {
	return rows.map((w) => ({ name: w.name, wrap: unb64(w.wrap) }));
}

function wrapsJson(ws: Wrap[]): { name: string; wrap: string }[] {
	return ws.map((w) => ({ name: w.name, wrap: b64(w.wrap) }));
}

function methodJson(m: { kind: MethodKind; publicKey: Uint8Array; sealed: Uint8Array; commit: Uint8Array; pkTag: Uint8Array }, authPublicKey?: Uint8Array) {
	return { kind: m.kind, publicKey: b64(m.publicKey), sealed: b64(m.sealed), commitment: b64(m.commit), pkTag: b64(m.pkTag), ...(authPublicKey ? { authPublicKey: b64(authPublicKey) } : {}) };
}

function recoveryMethods(keys: KeySet, salt: Uint8Array, recoveryKey: RecoverySecret | null, codes: RecoverySecret[]) {
	const out: ReturnType<typeof methodJson>[] = [];
	for (const s of [...(recoveryKey ? [recoveryKey] : []), ...codes]) {
		const mat = recoveryMaterial(s, salt);
		out.push(methodJson(createMethod(s.kind, mat.unlockSeed, keys.accountId, keys.generation, keys.rootKey, keys.ik), mat.authPublicKey));
	}
	return out;
}

export interface SignupSession {
	serverUrl: string;
	email: string;
	accountId: string;
	signupToken: string;
	serverIdentity: string;
	ksfVersion: number;
}

export class Vault {
	readonly api: ApiClient;
	private bundle: SecretBundle;
	private readonly o: VaultOptions;
	private pins = new Map<string, Uint8Array>();
	/** Public keys (base64url) of backup codes seen consumed; the server must not list them again. */
	private consumed = new Set<string>();
	private unverified: UnverifiedMethod[] = [];
	/** Email of the account this device joined; set by pairing so the UI can confirm whose vault it is. */
	accountEmail: string | null = null;
	/** Set after recovery sign-in: sync must not start before a new password is set (ADR 0005). */
	mustSetPassword = false;
	private recoveryGrant: string | null = null;

	private constructor(o: VaultOptions, bundle: SecretBundle) {
		this.o = o;
		this.bundle = bundle;
		this.api = new ApiClient(o.serverUrl, o.fetch);
		for (const [id, pk] of Object.entries(bundle.pins ?? {})) this.pins.set(id, unb64(pk));
		for (const pk of bundle.consumedMethods ?? []) this.consumed.add(pk);
	}

	/** Methods the last server listing offered that failed verification; never pinned, never sealed to. */
	get unverifiedMethods(): readonly UnverifiedMethod[] {
		return this.unverified;
	}

	// ---------------------------------------------------------------- signup (#28)

	static async signupStart(serverUrl: string, email: string, fetchImpl?: VaultOptions["fetch"]): Promise<void> {
		await new ApiClient(serverUrl, fetchImpl).post("/v1/signup/start", { email });
	}

	static async signupVerify(serverUrl: string, email: string, code: string, fetchImpl?: VaultOptions["fetch"]): Promise<SignupSession> {
		const r = await new ApiClient(serverUrl, fetchImpl).post<{ signupToken: string; accountId: string; serverIdentity: string; ksfVersion: number }>(
			"/v1/signup/verify", { email, code });
		return { serverUrl, email: email.trim().toLowerCase(), ...r };
	}

	/**
	 * Finishes signup: OPAQUE registration, ARK/VK/IK generation, the password, recovery key, ten
	 * backup code and device methods with commitments, all uploaded in one request. Returns the
	 * recovery key and backup codes for display exactly once.
	 */
	static async signupFinish(o: VaultOptions, s: SignupSession, password: string): Promise<{ vault: Vault; display: Required<RecoveryMaterialDisplay>; kit: EmergencyKit }> {
		password = password.normalize("NFC");
		const check = await checkPassword(password, o.password);
		if (!check.ok) throw new VaultError(`password_${check.reason}`, "The password does not meet the rules");
		const api = new ApiClient(s.serverUrl, o.fetch);
		const reg = startRegistration(password);
		const { registrationResponse } = await api.post<{ registrationResponse: string }>("/v1/signup/opaque", { signupToken: s.signupToken, registrationRequest: reg.request });
		const { record, exportKey } = reg.finish(registrationResponse, s.email, s.serverIdentity, s.ksfVersion);
		const keys = newAccountKeys(s.accountId);
		const salt = randomBytes(ACCOUNT_SALT_BYTES);
		const recoveryKey = generateRecoveryKey();
		const backupCodes = generateBackupCodes();
		const deviceSeed = o.ephemeral ? null : randomBytes(32);
		const methods = [
			methodJson(createMethod("password", passwordSeed(exportKey), s.accountId, 1, keys.rootKey, keys.ik)),
			...recoveryMethods(keys, salt, recoveryKey, backupCodes),
			...(deviceSeed ? [methodJson(createMethod("device", deviceSeed, s.accountId, 1, keys.rootKey, keys.ik))] : []),
		];
		const r = await api.post<SignInResponse>("/v1/signup/finish", {
			signupToken: s.signupToken, registrationRecord: record, ksfVersion: s.ksfVersion, accountSalt: b64(salt), expectedGeneration: 1,
			device: deviceInput(o), wraps: wrapsJson(wrapAllKeys(keys)), methods,
		});
		const vault = new Vault(o, {
			accountId: s.accountId, serverUrl: s.serverUrl, deviceId: r.deviceId, deviceToken: r.deviceToken, deviceSeed, deviceMethodId: null,
			generation: 1, rootKey: keys.rootKey, ik: keys.ik, vaultKeys: keys.vaultKeys, highWater: { generation: 1, epoch: 1 },
		});
		await vault.refreshPinsAndMethodId();
		await vault.save();
		const kit = vault.emergencyKit(s.email, recoveryKey);
		return { vault, display: { recoveryKey, backupCodes }, kit };
	}

	/** Signup confirmation (ADR 0005): one backup code, or the last 4 characters of the recovery key. */
	static confirmRecoveryMaterial(display: Required<RecoveryMaterialDisplay>, typed: string): boolean {
		const t = typed.replace(/[-\s]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
		const rk = display.recoveryKey.display().replace(/-/g, "");
		if (t.length === 4) return t === rk.slice(-4);
		return display.backupCodes.some((c) => c.display().replace(/-/g, "") === t);
	}

	emergencyKit(email: string, recoveryKey: RecoverySecret): EmergencyKit {
		const text = recoveryKey.display();
		return { email, serverUrl: this.o.serverUrl, recoveryKey: text, recoveryKeyQr: `lhv1-recovery:${this.o.serverUrl}:${encodeURIComponent(email)}:${text}`, createdAt: new Date().toISOString() };
	}

	// ---------------------------------------------------------------- sign-in and unlock (#28)

	/** Password sign-in on a new or expired device: OPAQUE, device token, unlock, device method. */
	static async signIn(o: VaultOptions, email: string, password: string): Promise<Vault> {
		const api = new ApiClient(o.serverUrl, o.fetch);
		let attempt: { login: { finish: ReturnType<typeof startLogin>["finish"] }; start: { loginId: string; loginResponse: string; ksfVersion: number; serverIdentity: string }; fin: NonNullable<ReturnType<ReturnType<typeof startLogin>["finish"]>> } | null = null;
		for (const pw of passwordVariants(password)) {
			const login = startLogin(pw);
			const start = await api.post<{ loginId: string; loginResponse: string; ksfVersion: number; serverIdentity: string }>("/v1/login/start", { email, startLoginRequest: login.request });
			const fin = login.finish(start.loginResponse, email.trim().toLowerCase(), start.serverIdentity, start.ksfVersion);
			if (fin) {
				attempt = { login, start, fin };
				break;
			}
		}
		if (!attempt) throw new VaultError("login_failed", "Wrong email or password");
		const { start, fin } = attempt;
		const r = await api.post<SignInResponse>("/v1/login/finish", { loginId: start.loginId, finishLoginRequest: fin.finishRequest, device: deviceInput(o) });
		const previous = await o.storage.load().catch(() => null);
		const vault = await Vault.unlockFresh(o, r, "password", passwordSeed(fin.exportKey), previous);
		await vault.ensureDeviceMethod();
		return vault;
	}

	/**
	 * Opens a vault from storage on launch (unlock on launch). Returns null when signed out.
	 * Pulls the current keys when online and applies rotation acceptance.
	 */
	static async open(o: VaultOptions): Promise<Vault | null> {
		const bundle = await o.storage.load();
		if (!bundle) return null;
		const v = new Vault(o, bundle);
		try {
			await v.refreshKeys();
		} catch (e) {
			if (e instanceof ApiError && e.status === 401) {
				// Expired or revoked token: keys stay, the device signs in again (ADR 0004).
				throw new VaultError("signed_out", "This device must sign in again");
			}
			if (!(e instanceof Error && e.name === "NetworkError")) throw e;
		}
		return v;
	}

	private static async unlockFresh(o: VaultOptions, r: SignInResponse, kind: MethodKind, seed: Uint8Array, previous: SecretBundle | null): Promise<Vault> {
		const api = new ApiClient(o.serverUrl, o.fetch);
		const k = await api.get<KeysResponse>("/v1/keys", { token: r.deviceToken });
		const kp = boxKeyPairFromSeed(seed);
		const row = k.methods.find((m) => m.kind === kind && bytesEqual(unb64(m.publicKey), kp.publicKey));
		if (!row) throw new VaultError("no_method", `This account has no ${kind} unlock method for this secret`);
		const highWater = previous && previous.accountId === r.accountId ? previous.highWater : undefined;
		const keys = unlock({
			accountId: r.accountId, generation: k.generation, epoch: k.epoch, wraps: wrapsFrom(k.wraps), seed, keyPair: kp, highWater,
			method: { kind, publicKey: unb64(row.publicKey), sealed: unb64(row.sealed), commit: row.commitment ? unb64(row.commitment) : null },
		});
		checkAgainstHeld(previous, keys);
		const keepSeed = previous && previous.accountId === r.accountId && previous.deviceSeed && !o.ephemeral ? previous : null;
		const v = new Vault(o, {
			accountId: r.accountId, serverUrl: o.serverUrl, deviceId: r.deviceId, deviceToken: r.deviceToken,
			deviceSeed: keepSeed?.deviceSeed ?? null, deviceMethodId: null, generation: keys.generation, rootKey: keys.rootKey, ik: keys.ik,
			vaultKeys: keys.vaultKeys, highWater: { generation: keys.generation, epoch: k.epoch },
			...carriedTrust(previous, r.accountId),
		});
		v.pinAll(k.methods);
		await v.save();
		return v;
	}

	/** Creates and uploads this device's `device` unlock method unless ephemeral or already present. */
	private async ensureDeviceMethod(): Promise<void> {
		if (this.o.ephemeral) return;
		const k = await this.keysResponse();
		if (this.bundle.deviceSeed) {
			const kp = boxKeyPairFromSeed(this.bundle.deviceSeed);
			const mine = k.methods.find((m) => m.kind === "device" && bytesEqual(unb64(m.publicKey), kp.publicKey));
			if (mine?.commitment) {
				this.bundle = { ...this.bundle, deviceMethodId: mine.id };
				return this.save();
			}
		}
		const seed = randomBytes(32);
		const m = createMethod("device", seed, this.bundle.accountId, this.bundle.generation, this.bundle.rootKey, this.bundle.ik);
		const r = await this.api.post<{ methodId: string }>("/v1/methods", { expectedGeneration: this.bundle.generation, ...methodJson(m) }, this.auth());
		this.pins.set(r.methodId, m.publicKey);
		this.bundle = { ...this.bundle, deviceSeed: seed, deviceMethodId: r.methodId };
		await this.save();
	}

	// ---------------------------------------------------------------- state

	get accountId(): string {
		return this.bundle.accountId;
	}
	get deviceId(): string {
		return this.bundle.deviceId;
	}
	get token(): string {
		return this.bundle.deviceToken;
	}
	get ephemeral(): boolean {
		return !!this.o.ephemeral;
	}
	/** The unlocked key set. */
	get keys(): KeySet {
		return { accountId: this.bundle.accountId, generation: this.bundle.generation, rootKey: this.bundle.rootKey, ik: this.bundle.ik, vaultKeys: this.bundle.vaultKeys };
	}
	get epoch(): number {
		return currentEpoch(this.keys);
	}
	get options(): VaultOptions {
		return this.o;
	}

	auth(reauth?: string): { token: string; reauth?: string } {
		return reauth ? { token: this.bundle.deviceToken, reauth } : { token: this.bundle.deviceToken };
	}

	private saveChain: Promise<unknown> = Promise.resolve();

	/** Saves are serialized so concurrent callers cannot write bundles out of order. */
	private save(): Promise<void> {
		const run = async (): Promise<void> => {
			const pins: Record<string, string> = {};
			for (const [id, pk] of this.pins) pins[id] = b64(pk);
			this.bundle = { ...this.bundle, pins, consumedMethods: [...this.consumed] };
			await this.o.storage.save(this.bundle);
		};
		const p = this.saveChain.then(run, run);
		this.saveChain = p.catch(() => undefined);
		return p;
	}

	/** Remembers a consumed backup code's public key so a server that keeps listing it is caught. */
	private markConsumed(pk: Uint8Array | undefined): void {
		if (pk) this.consumed.add(b64(pk));
	}

	async keysResponse(): Promise<KeysResponse> {
		return this.api.get<KeysResponse>("/v1/keys", this.auth());
	}

	/**
	 * Classifies one listed method: null when it may be pinned and sealed to. Does not throw, so one
	 * bogus row cannot block sign-in or recovery for everyone.
	 */
	private checkMethod(m: MethodRow): UnverifiedMethod["reason"] | null {
		let pk: Uint8Array;
		try {
			pk = unb64(m.publicKey);
			verifyPkTag(unb64(m.pkTag), this.bundle.ik, this.bundle.accountId, m.kind, pk);
		} catch {
			return "pk_tag_mismatch";
		}
		if (this.consumed.has(b64(pk))) return "consumed";
		const pin = this.pins.get(m.id);
		if (pin && !bytesEqual(pin, pk)) return "pin_mismatch";
		return null;
	}

	/** Pins verified methods seen for the first time; skips and records the rest in `unverifiedMethods`. */
	private pinAll(methods: MethodRow[]): void {
		this.unverified = [];
		for (const m of methods) {
			const bad = this.checkMethod(m);
			if (bad) {
				this.unverified.push({ id: m.id, kind: m.kind, reason: bad });
				continue;
			}
			this.pins.set(m.id, unb64(m.publicKey));
		}
	}

	private async refreshPinsAndMethodId(): Promise<void> {
		const k = await this.keysResponse();
		this.pinAll(k.methods);
		if (this.bundle.deviceSeed) {
			const kp = boxKeyPairFromSeed(this.bundle.deviceSeed);
			const mine = k.methods.find((m) => m.kind === "device" && bytesEqual(unb64(m.publicKey), kp.publicKey));
			if (mine) this.bundle = { ...this.bundle, deviceMethodId: mine.id };
		}
	}

	/**
	 * Fetches the account's keys; if the generation moved on, opens the new root key with this
	 * device's method and applies rotation acceptance (ADR 0002 rule 2). Throws on rejection.
	 */
	async refreshKeys(k?: KeysResponse): Promise<{ rotated: boolean }> {
		const keys = k ?? (await this.keysResponse());
		if (keys.generation < this.bundle.highWater.generation || keys.epoch < this.bundle.highWater.epoch) {
			throw new ProtocolError("rollback", "The server offered an older generation than this device accepted");
		}
		if (keys.generation === this.bundle.generation) return { rotated: false };
		if (!this.bundle.deviceSeed) throw new VaultError("needs_unlock", "The keys changed; unlock again with the password, a passkey or recovery material");
		const kp = boxKeyPairFromSeed(this.bundle.deviceSeed);
		const mine = keys.methods.find((m) => m.kind === "device" && bytesEqual(unb64(m.publicKey), kp.publicKey));
		if (!mine) throw new VaultError("revoked", "This device's unlock method is gone; the device was revoked");
		const opened = openRootKey(unb64(mine.sealed), kp);
		if (opened.generation !== keys.generation) throw new ProtocolError("rotation_rejected", `The sealed root key is for generation ${opened.generation}, the server claims ${keys.generation}`);
		const next = acceptRotation(this.keys, opened.generation, opened.rootKey, keys.epoch, wrapsFrom(keys.wraps));
		this.bundle = { ...this.bundle, generation: next.generation, rootKey: next.rootKey, vaultKeys: next.vaultKeys, highWater: { generation: next.generation, epoch: currentEpoch(next) } };
		await this.save();
		return { rotated: true };
	}

	// ---------------------------------------------------------------- account info

	account(): Promise<AccountResponse> {
		return this.api.get<AccountResponse>("/v1/account", this.auth());
	}

	async devices(): Promise<DeviceRow[]> {
		return (await this.api.get<{ devices: DeviceRow[] }>("/v1/devices", this.auth())).devices;
	}

	async renameDevice(id: string, name: string): Promise<void> {
		await this.api.json("PATCH", `/v1/devices/${id}`, { name: checkDeviceName(name) }, this.auth());
	}

	/** Signs this device out: revokes its token and deletes local secrets, without rotation. */
	async signOut(): Promise<void> {
		try {
			await this.api.post("/v1/devices/self/signout", {}, this.auth());
		} finally {
			await this.o.storage.clear();
		}
	}

	// ---------------------------------------------------------------- re-authentication (ADR 0013)

	async reauthPassword(password: string): Promise<string> {
		const email = (await this.account()).email;
		let start: { loginId: string; loginResponse: string; ksfVersion: number; serverIdentity: string } | null = null;
		let fin: ReturnType<ReturnType<typeof startLogin>["finish"]> = null;
		for (const pw of passwordVariants(password)) {
			const login = startLogin(pw);
			start = await this.api.post<{ loginId: string; loginResponse: string; ksfVersion: number; serverIdentity: string }>("/v1/reauth/password/start", { startLoginRequest: login.request }, this.auth());
			fin = login.finish(start.loginResponse, email, start.serverIdentity, start.ksfVersion);
			if (fin) break;
		}
		if (!fin || !start) throw new VaultError("login_failed", "Wrong password");
		return (await this.api.post<GrantResponse>("/v1/reauth/password/finish", { loginId: start.loginId, finishLoginRequest: fin.finishRequest }, this.auth())).grant;
	}

	/** Re-authenticates with the recovery key or a backup code (a backup code is consumed). */
	async reauthRecovery(text: string): Promise<string> {
		const kind = guessRecoveryKind(text);
		if (!kind) throw new VaultError("bad_code", "That is not a recovery key or backup code");
		const secret = parseRecoverySecret(kind, text);
		const ch = await this.api.post<{ challengeId: string; accountId: string; accountSalt: string; challenge: string }>("/v1/reauth/recovery/start", {}, this.auth());
		const mat = recoveryMaterial(secret, unb64(ch.accountSalt));
		const sig = signRecoveryChallenge(mat, ch.accountId, unb64(ch.challenge));
		const g = await this.api.post<GrantResponse>("/v1/reauth/recovery/finish", { challengeId: ch.challengeId, authPublicKey: b64(mat.authPublicKey), signature: b64(sig) }, this.auth());
		if (kind === "backup_code") this.markConsumed(mat.unlock.publicKey);
		if (g.consumedMethodId) {
			this.markConsumed(this.pins.get(g.consumedMethodId));
			this.pins.delete(g.consumedMethodId);
		}
		await this.save();
		return g.grant;
	}

	// ---------------------------------------------------------------- rotation (#28, #33)

	/**
	 * Builds a rotation: verifies pkTags and pins, asks to confirm methods not seen before, seals
	 * the next root key to every remaining method. `remove` decides which current methods go.
	 */
	async buildRotation(remove: (m: MethodRow) => boolean): Promise<{ k: KeysResponse; next: KeySet; body: { expectedGeneration: number; epoch: number; wraps: { name: string; wrap: string }[]; seals: { methodId: string; sealed: string }[] } }> {
		const k = await this.keysResponse();
		await this.refreshKeys(k);
		const remaining = k.methods.filter((m) => !remove(m) && !(m.kind === "device" && m.commitment === null));
		const bad: UnverifiedMethod[] = [];
		for (const m of remaining) {
			const reason = this.checkMethod(m);
			if (reason) bad.push({ id: m.id, kind: m.kind, reason });
		}
		const consumed = bad.filter((x) => x.reason === "consumed");
		if (consumed.length > 0) {
			throw new VaultError("server_kept_consumed_method", `The server still lists a backup code that was used up: ${consumed.map((c) => c.id).join(", ")}. Remove it with removeMethod or stop trusting this server.`, consumed.map((c) => c.id));
		}
		if (bad.length > 0) {
			throw new VaultError("unverified_methods", `Unlock methods that do not belong to this account block the rotation: ${bad.map((c) => `${c.id} (${c.reason})`).join(", ")}. Remove them with removeMethod.`, bad.map((c) => c.id));
		}
		const unseen = remaining.filter((m) => !this.pins.has(m.id));
		if (unseen.length > 0) {
			const ok = this.o.confirmNewMethods ? await this.o.confirmNewMethods(unseen) : false;
			if (!ok) throw new VaultError("methods_not_confirmed", "New unlock methods were not confirmed", unseen.map((m) => m.id));
			for (const m of unseen) this.pins.set(m.id, unb64(m.publicKey));
			await this.save();
		}
		const forSeal: MethodForSeal[] = remaining.map((m) => ({ id: m.id, kind: m.kind, publicKey: unb64(m.publicKey), pkTag: unb64(m.pkTag) }));
		const rot = buildRotation(this.keys, forSeal, this.pins);
		return {
			k, next: rot.next,
			body: { expectedGeneration: k.generation, epoch: currentEpoch(rot.next), wraps: wrapsJson(rot.wraps), seals: rot.seals.map((s) => ({ methodId: s.methodId, sealed: b64(s.sealed) })) },
		};
	}

	private async submitRotation(next: KeySet, body: object, grant: string, removedIds: string[]): Promise<RotationOutcome> {
		const r = await this.api.post<{ status: "applied" | "pending"; generation?: number; pendingAction?: PendingAction }>("/v1/rotate", body, this.auth(grant));
		if (r.status === "pending") return { status: "pending", pendingAction: r.pendingAction as PendingAction };
		this.bundle = { ...this.bundle, generation: next.generation, rootKey: next.rootKey, vaultKeys: next.vaultKeys, highWater: { generation: next.generation, epoch: currentEpoch(next) } };
		for (const id of removedIds) this.pins.delete(id);
		await this.save();
		await this.refreshPinsAndMethodId();
		await this.save();
		return { status: "applied", generation: next.generation };
	}

	/** Revokes a lost device (ADR 0006). Pending for 24 h unless the grant came from recovery material. */
	async revokeDevice(deviceId: string, grant: string): Promise<RotationOutcome> {
		if (deviceId === this.bundle.deviceId) throw new VaultError("bad_request", "Use signOut for this device");
		const { next, body, k } = await this.buildRotation((m) => m.deviceId === deviceId);
		const removed = k.methods.filter((m) => m.deviceId === deviceId).map((m) => m.id);
		return this.submitRotation(next, { ...body, action: { kind: "revoke_device", deviceId } }, grant, removed);
	}

	/** Changes the password: OPAQUE re-registration and a rotation (ADR 0004). */
	async changePassword(newPassword: string, grant: string): Promise<RotationOutcome> {
		newPassword = newPassword.normalize("NFC");
		const check = await checkPassword(newPassword, this.o.password);
		if (!check.ok) throw new VaultError(`password_${check.reason}`, "The password does not meet the rules");
		const email = (await this.account()).email;
		const reg = startRegistration(newPassword);
		const r = await this.api.post<{ registrationResponse: string; serverIdentity: string; ksfVersion: number }>("/v1/password/opaque", { registrationRequest: reg.request }, this.auth());
		const { record, exportKey } = reg.finish(r.registrationResponse, email, r.serverIdentity, CURRENT_KSF_VERSION);
		const { next, body, k } = await this.buildRotation((m) => m.kind === "password");
		const method = methodJson(createMethod("password", passwordSeed(exportKey), next.accountId, next.generation, next.rootKey, next.ik));
		const out = await this.submitRotation(next, { ...body, action: { kind: "change_password", registrationRecord: record, ksfVersion: CURRENT_KSF_VERSION, methods: [method] } },
			grant, k.methods.filter((m) => m.kind === "password").map((m) => m.id));
		this.mustSetPassword = false;
		return out;
	}

	/** Regenerates the recovery key (ADR 0005). Returns the new key for display once. */
	async regenerateRecoveryKey(grant: string): Promise<RotationOutcome & { recoveryKey: RecoverySecret }> {
		const k0 = await this.keysResponse();
		const salt = unb64(k0.accountSalt);
		const { next, body, k } = await this.buildRotation((m) => m.kind === "recovery_key");
		const recoveryKey = generateRecoveryKey();
		const methods = recoveryMethods(next, salt, recoveryKey, []);
		const out = await this.submitRotation(next, { ...body, action: { kind: "regenerate_recovery_key", methods } }, grant, k.methods.filter((m) => m.kind === "recovery_key").map((m) => m.id));
		return { ...out, recoveryKey };
	}

	/** Regenerates all ten backup codes (ADR 0005). */
	async regenerateBackupCodes(grant: string): Promise<RotationOutcome & { backupCodes: RecoverySecret[] }> {
		const k0 = await this.keysResponse();
		const salt = unb64(k0.accountSalt);
		const { next, body, k } = await this.buildRotation((m) => m.kind === "backup_code");
		const backupCodes = generateBackupCodes();
		const methods = recoveryMethods(next, salt, null, backupCodes);
		const out = await this.submitRotation(next, { ...body, action: { kind: "regenerate_backup_codes", methods } }, grant, k.methods.filter((m) => m.kind === "backup_code").map((m) => m.id));
		return { ...out, backupCodes };
	}

	/**
	 * Deletes an unlock method row (for example one that failed verification, or a consumed backup
	 * code the server kept). Needs a re-authentication grant. The local pin for it is dropped.
	 */
	async removeMethod(id: string, grant: string): Promise<void> {
		await this.api.json("DELETE", `/v1/methods/${id}`, undefined, this.auth(grant));
		this.pins.delete(id);
		this.unverified = this.unverified.filter((u) => u.id !== id);
		await this.save();
	}

	async confirmPending(id: string, grant: string): Promise<void> {
		await this.api.post(`/v1/pending/${id}/confirm`, {}, this.auth(grant));
		await this.refreshKeys();
	}

	async cancelPending(id: string, grant: string): Promise<void> {
		await this.api.post(`/v1/pending/${id}/cancel`, {}, this.auth(grant));
	}

	/** Deletes the account (ADR 0010); local data stays, local secrets are cleared. */
	async deleteAccount(grant: string): Promise<void> {
		await this.api.json("DELETE", "/v1/account", undefined, this.auth(grant));
		await this.o.storage.clear();
	}

	// ---------------------------------------------------------------- recovery sign-in (#29)

	/**
	 * Recovery sign-in with the recovery key or a backup code. The vault is unlocked, but
	 * `mustSetPassword` is true: call setNewPassword before sync starts (ADR 0005).
	 */
	static async recover(o: VaultOptions, email: string, text: string): Promise<Vault> {
		const kind = guessRecoveryKind(text);
		if (!kind) throw new VaultError("bad_code", "That is not a recovery key or backup code");
		const secret = parseRecoverySecret(kind, text);
		const api = new ApiClient(o.serverUrl, o.fetch);
		const ch = await api.post<{ challengeId: string; accountId: string; accountSalt: string; challenge: string }>("/v1/recovery/start", { email });
		const mat = recoveryMaterial(secret, unb64(ch.accountSalt));
		const sig = signRecoveryChallenge(mat, ch.accountId, unb64(ch.challenge));
		const r = await api.post<SignInResponse & { method: MethodRow; reauthGrant: string }>("/v1/recovery/finish", {
			challengeId: ch.challengeId, authPublicKey: b64(mat.authPublicKey), signature: b64(sig), device: deviceInput(o),
		});
		const k = await api.get<KeysResponse>("/v1/keys", { token: r.deviceToken });
		const previous = await o.storage.load().catch(() => null);
		const highWater = previous && previous.accountId === r.accountId ? previous.highWater : undefined;
		const keys = unlock({
			accountId: r.accountId, generation: k.generation, epoch: k.epoch, wraps: wrapsFrom(k.wraps), seed: mat.unlockSeed, keyPair: mat.unlock, highWater,
			method: { kind, publicKey: unb64(r.method.publicKey), sealed: unb64(r.method.sealed), commit: r.method.commitment ? unb64(r.method.commitment) : null },
		});
		checkAgainstHeld(previous, keys);
		const v = new Vault(o, {
			accountId: r.accountId, serverUrl: o.serverUrl, deviceId: r.deviceId, deviceToken: r.deviceToken, deviceSeed: null, deviceMethodId: null,
			generation: keys.generation, rootKey: keys.rootKey, ik: keys.ik, vaultKeys: keys.vaultKeys, highWater: { generation: keys.generation, epoch: k.epoch },
			...carriedTrust(previous, r.accountId),
		});
		// A backup code is consumed by this sign-in; a server that keeps listing it must not get it pinned or sealed to.
		if (kind === "backup_code") v.markConsumed(mat.unlock.publicKey);
		v.pinAll(k.methods);
		await v.save();
		v.mustSetPassword = true;
		v.recoveryGrant = r.reauthGrant;
		return v;
	}

	/** Sets the new password after recovery sign-in, using the grant from the recovery proof. */
	async setNewPassword(newPassword: string): Promise<RotationOutcome> {
		if (!this.recoveryGrant) throw new VaultError("bad_request", "No recovery sign-in is pending");
		const out = await this.changePassword(newPassword, this.recoveryGrant);
		this.recoveryGrant = null;
		await this.ensureDeviceMethod();
		return out;
	}

	// ---------------------------------------------------------------- pairing (#32)

	/** Signed-in device shows the QR code. */
	async pairShow(): Promise<{ pairingId: string; qr: string; text: string; secret: Uint8Array }> {
		const r = await this.api.post<{ pairingId: string }>("/v1/pairing", { shownBy: "approver" }, this.auth());
		const secret = generatePairingSecret();
		return { pairingId: r.pairingId, qr: encodePairingQr({ serverUrl: this.o.serverUrl, pairingId: r.pairingId, secret }), text: encodePairingText(secret), secret };
	}

	/**
	 * Signed-in device: waits for the join (or reads it after scanning a joiner's code), verifies
	 * joinTag before anything is shown, and returns the name and code for the learner.
	 */
	async pairReview(pairingId: string, secret: Uint8Array, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<{ name: string; code: string; publicKey: Uint8Array }> {
		const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
		for (;;) {
			const r = await this.api.get<{ state: string; join?: { publicKey: string; joinTag: string; name: string; lhDeviceId: string; ephemeral: boolean } }>(`/v1/pairing/${pairingId}`, this.auth());
			if (r.join) {
				const pk = unb64(r.join.publicKey);
				verifyJoinTag(unb64(r.join.joinTag), secret, pairingId, pk, r.join.name, r.join.lhDeviceId, r.join.ephemeral);
				return { name: r.join.name, code: confirmationCode(pk), publicKey: pk };
			}
			if (Date.now() > deadline) throw new VaultError("pairing_timeout", "No device joined");
			await new Promise((res) => setTimeout(res, opts.intervalMs ?? 1000));
		}
	}

	/** Signed-in device: approve after the learner confirmed the code. */
	async pairApprove(pairingId: string, secret: Uint8Array, publicKey: Uint8Array): Promise<void> {
		await this.refreshKeys();
		const sealed = sealRootKey(this.bundle.generation, this.bundle.rootKey, publicKey);
		await this.api.post(`/v1/pairing/${pairingId}/approve`, {
			sealed: b64(sealed), approveTag: b64(approveTag(secret, pairingId, publicKey, sealed)),
			pkTag: b64(pkTag(this.bundle.ik, this.bundle.accountId, "device", publicKey)), expectedGeneration: this.bundle.generation,
		}, this.auth());
	}

	/** Signed-in device scanned a code shown by the new device. */
	static parsePairingCode(qrOrText: string, serverUrl?: string, pairingId?: string): { serverUrl: string; pairingId: string; secret: Uint8Array } {
		if (qrOrText.startsWith("lhv1-pair:")) return decodePairingQr(qrOrText);
		if (!serverUrl || !pairingId) throw new VaultError("bad_code", "The text code needs the pairing id");
		return { serverUrl, pairingId, secret: decodePairingText(qrOrText) };
	}

	/** New device shows the QR code (it has a camera-less peer, or prefers to show). */
	static async pairShowAsJoiner(o: VaultOptions): Promise<JoinerPairing> {
		const api = new ApiClient(o.serverUrl, o.fetch);
		const r = await api.post<{ pairingId: string; joinerToken: string }>("/v1/pairing", { shownBy: "joiner" });
		const secret = generatePairingSecret();
		const p = new JoinerPairing(o, r.pairingId, secret, r.joinerToken);
		await p.join();
		return p;
	}

	/** New device scanned the signed-in device's QR code. */
	static async pairJoin(o: VaultOptions, qr: string): Promise<JoinerPairing> {
		const p = decodePairingQr(qr);
		if (p.serverUrl.replace(/\/+$/, "") !== o.serverUrl.replace(/\/+$/, "")) throw new VaultError("bad_code", "This pairing code is for another vault server");
		const jp = new JoinerPairing(o, p.pairingId, p.secret, null);
		await jp.join();
		return jp;
	}

	// ---------------------------------------------------------------- passkeys (#30)

	/** Starts registration; the host runs navigator.credentials.create with `options`. */
	async passkeyRegisterStart(grant: string): Promise<{ ceremonyId: string; options: unknown; prfSalt: Uint8Array }> {
		const r = await this.api.post<{ ceremonyId: string; options: unknown; prfSalt: string }>("/v1/passkeys/register/start", {}, this.auth(grant));
		return { ceremonyId: r.ceremonyId, options: r.options, prfSalt: unb64(r.prfSalt) };
	}

	/**
	 * Finishes registration. With a PRF output the passkey also becomes an unlock method;
	 * without it, it is sign-in only. PRF results are stripped from the credential before upload.
	 */
	async passkeyRegisterFinish(ceremonyId: string, credential: unknown, name: string, prfOutput: Uint8Array | null, grant: string): Promise<{ passkeyId: string; signInOnly: boolean }> {
		await this.refreshKeys();
		const method = prfOutput ? methodJson(createMethod("passkey", passkeySeed(prfOutput), this.bundle.accountId, this.bundle.generation, this.bundle.rootKey, this.bundle.ik)) : null;
		const r = await this.api.post<{ passkeyId: string; signInOnly: boolean; methodId: string | null }>("/v1/passkeys/register/finish", {
			ceremonyId, credential: stripPrfResults(credential), name, method, expectedGeneration: this.bundle.generation,
		}, this.auth(grant));
		if (r.methodId && method) {
			this.pins.set(r.methodId, unb64(method.publicKey));
			await this.save();
		}
		return r;
	}

	async passkeys(): Promise<{ id: string; name: string; signInOnly: boolean; methodId: string | null }[]> {
		return (await this.api.get<{ passkeys: { id: string; name: string; signInOnly: boolean; methodId: string | null }[] }>("/v1/passkeys", this.auth())).passkeys;
	}

	/** Removes a passkey; one that can unlock is removed with a rotation (ADR 0006). */
	async removePasskey(passkeyId: string, grant: string): Promise<RotationOutcome> {
		const list = await this.passkeys();
		const p = list.find((x) => x.id === passkeyId);
		if (!p) throw new VaultError("not_found", "No such passkey");
		if (p.signInOnly) {
			await this.api.json("DELETE", `/v1/passkeys/${passkeyId}`, undefined, this.auth(grant));
			return { status: "applied", generation: this.bundle.generation };
		}
		const { next, body, k } = await this.buildRotation((m) => m.passkeyId === passkeyId);
		return this.submitRotation(next, { ...body, action: { kind: "remove_passkey", passkeyId } }, grant, k.methods.filter((m) => m.passkeyId === passkeyId).map((m) => m.id));
	}

	async reauthPasskeyStart(): Promise<{ ceremonyId: string; options: unknown }> {
		return this.api.post("/v1/reauth/passkey/start", {}, this.auth());
	}

	async reauthPasskeyFinish(ceremonyId: string, credential: unknown): Promise<string> {
		return (await this.api.post<GrantResponse>("/v1/reauth/passkey/finish", { ceremonyId, credential: stripPrfResults(credential) }, this.auth())).grant;
	}

	static async passkeySignInStart(o: VaultOptions, email: string): Promise<{ ceremonyId: string; options: unknown }> {
		return new ApiClient(o.serverUrl, o.fetch).post("/v1/passkeys/login/start", { email });
	}

	/**
	 * Finishes passkey sign-in. With a PRF output the vault unlocks; without one the result is
	 * `{ status: "needs_unlock" }` and the UI offers pairing, password or recovery material.
	 */
	static async passkeySignInFinish(o: VaultOptions, ceremonyId: string, credential: unknown, prfOutput: Uint8Array | null): Promise<{ status: "unlocked"; vault: Vault } | { status: "needs_unlock"; session: SignInResponse }> {
		const api = new ApiClient(o.serverUrl, o.fetch);
		const r = await api.post<SignInResponse>("/v1/passkeys/login/finish", { ceremonyId, credential: stripPrfResults(credential), device: deviceInput(o) });
		if (!prfOutput) return { status: "needs_unlock", session: r };
		const previous = await o.storage.load().catch(() => null);
		const vault = await Vault.unlockFresh(o, r, "passkey", passkeySeed(prfOutput), previous);
		await vault.ensureDeviceMethod();
		return { status: "unlocked", vault };
	}

	/** Unlocks a signed-in but locked session (passkey without PRF) with the password. */
	static async unlockSessionWithPassword(o: VaultOptions, session: SignInResponse, email: string, password: string): Promise<Vault> {
		const api = new ApiClient(o.serverUrl, o.fetch);
		let fin: ReturnType<ReturnType<typeof startLogin>["finish"]> = null;
		for (const pw of passwordVariants(password)) {
			const login = startLogin(pw);
			const start = await api.post<{ loginId: string; loginResponse: string; ksfVersion: number; serverIdentity: string }>("/v1/reauth/password/start", { startLoginRequest: login.request }, { token: session.deviceToken });
			fin = login.finish(start.loginResponse, email.trim().toLowerCase(), start.serverIdentity, start.ksfVersion);
			if (fin) break;
		}
		if (!fin) throw new VaultError("login_failed", "Wrong password");
		const previous = await o.storage.load().catch(() => null);
		const vault = await Vault.unlockFresh(o, session, "password", passwordSeed(fin.exportKey), previous);
		await vault.ensureDeviceMethod();
		return vault;
	}

	// ---------------------------------------------------------------- export (ADR 0010)

	/** Downloads the export archive (a tar of ciphertext). */
	async downloadExport(): Promise<Uint8Array> {
		const res = await this.api.raw("GET", "/v1/export", this.auth());
		return new Uint8Array(await res.arrayBuffer());
	}

	/** Internal: used by JoinerPairing to finish. */
	static fromPairing(o: VaultOptions, bundle: SecretBundle, methods: MethodRow[]): Vault {
		const v = new Vault(o, bundle);
		v.pinAll(methods);
		return v;
	}

	/** Internal: persist after pairing. */
	async persist(): Promise<void> {
		await this.save();
	}

	/** In-memory storage for ephemeral devices and tests. */
	static memoryStorage(): KeyStorage {
		return new MemoryKeyStorage();
	}
}

/** Removes `clientExtensionResults.prf.results` from a WebAuthn credential JSON (ADR 0004). */
export function stripPrfResults(credential: unknown): unknown {
	if (typeof credential !== "object" || credential === null) return credential;
	const c = structuredClone(credential) as Record<string, unknown>;
	const ext = c["clientExtensionResults"] as Record<string, unknown> | undefined;
	const prf = ext?.["prf"] as Record<string, unknown> | undefined;
	if (prf && "results" in prf) delete prf["results"];
	return c;
}

/** The new device's side of pairing (#32). */
export class JoinerPairing {
	readonly code: string;
	private readonly seed: Uint8Array;
	private readonly publicKey: Uint8Array;
	readonly qr: string;
	readonly text: string;
	constructor(private readonly o: VaultOptions, readonly pairingId: string, private readonly secret: Uint8Array, private joinerToken: string | null) {
		this.seed = randomBytes(32);
		this.publicKey = boxKeyPairFromSeed(this.seed).publicKey;
		this.code = confirmationCode(this.publicKey);
		this.qr = encodePairingQr({ serverUrl: o.serverUrl, pairingId, secret });
		this.text = encodePairingText(secret);
	}

	async join(): Promise<void> {
		const api = new ApiClient(this.o.serverUrl, this.o.fetch);
		const r = await api.post<{ joinerToken?: string }>(`/v1/pairing/${this.pairingId}/join`, {
			publicKey: b64(this.publicKey), joinTag: b64(joinTag(this.secret, this.pairingId, this.publicKey, checkDeviceName(this.o.device.name), this.o.device.lhDeviceId, !!this.o.ephemeral)), device: deviceInput(this.o),
		}, this.joinerToken ? { pairingToken: this.joinerToken } : {});
		if (r.joinerToken) this.joinerToken = r.joinerToken;
	}

	/**
	 * Waits for approval, verifies approveTag, opens the root key and the sealed device token,
	 * unwraps and uploads the commitment. The returned vault has `accountEmail` set: the UI must show
	 * "Joining the vault of <email>" and let the learner cancel (signOut) before sync starts.
	 */
	async finish(opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Vault> {
		const api = new ApiClient(this.o.serverUrl, this.o.fetch);
		const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
		let ap: { accountId: string; deviceId: string; methodId: string | null; deviceTokenSealed: string; sealed: string; approveTag: string; generation: number } | undefined;
		for (;;) {
			const r = await api.get<{ state: string; approval?: typeof ap }>(`/v1/pairing/${this.pairingId}`, { pairingToken: this.joinerToken ?? "" });
			if (r.approval) {
				ap = r.approval;
				break;
			}
			if (Date.now() > deadline) throw new VaultError("pairing_timeout", "The pairing was not approved");
			await new Promise((res) => setTimeout(res, opts.intervalMs ?? 1000));
		}
		const sealed = unb64(ap.sealed);
		verifyApproveTag(unb64(ap.approveTag), this.secret, this.pairingId, this.publicKey, sealed);
		const kp = boxKeyPairFromSeed(this.seed);
		const opened = openRootKey(sealed, kp);
		// The device token travels sealed to this device's public key, so the pairing poll never exposes it.
		let deviceToken: string;
		try {
			deviceToken = fromUtf8(sodium.crypto_box_seal_open(unb64(ap.deviceTokenSealed), kp.publicKey, kp.secretKey));
		} catch {
			throw new VaultError("pairing_failed", "The device token in the approval could not be opened");
		}
		// Whose vault is this? In joiner-shown pairing anyone who photographed the QR can approve into their own account.
		const account = await api.get<AccountResponse>("/v1/account", { token: deviceToken });
		if (account.accountId !== ap.accountId) throw new VaultError("pairing_failed", "The approval names another account than the server reports");
		const k = await api.get<KeysResponse>("/v1/keys", { token: deviceToken });
		if (k.generation !== opened.generation) throw new VaultError("pairing_cancelled", "The keys changed during pairing; pair again");
		const ks = acceptFromPairing(ap.accountId, opened.generation, opened.rootKey, k);
		if (ap.methodId) {
			const commit = commitment(this.seed, ap.accountId, "device", this.publicKey, ks.ik);
			try {
				await api.json("PUT", `/v1/methods/${ap.methodId}/commitment`, { commitment: b64(commit) }, { token: deviceToken });
			} catch (e) {
				if (e instanceof ApiError && (e.status === 409 || e.status === 401)) throw new VaultError("pairing_cancelled", "The pairing was cancelled by a key rotation; pair again");
				throw e;
			}
		}
		const v = Vault.fromPairing(this.o, {
			accountId: ap.accountId, serverUrl: this.o.serverUrl, deviceId: ap.deviceId, deviceToken,
			deviceSeed: ap.methodId ? this.seed : null, deviceMethodId: ap.methodId, generation: ks.generation, rootKey: ks.rootKey, ik: ks.ik,
			vaultKeys: ks.vaultKeys, highWater: { generation: ks.generation, epoch: k.epoch },
		}, k.methods);
		v.accountEmail = account.email;
		await v.persist();
		return v;
	}
}

/** Pins and consumed backup codes this device already holds for the same account survive a fresh sign-in. */
function carriedTrust(previous: SecretBundle | null, accountId: string): { pins?: Readonly<Record<string, string>>; consumedMethods?: readonly string[] } {
	if (!previous || previous.accountId !== accountId) return {};
	return { pins: previous.pins ?? {}, consumedMethods: previous.consumedMethods ?? [] };
}

/**
 * When this device already held keys for the account, a fresh unlock must open the same IK and
 * VK_1..VK_e (rotation acceptance semantics, ADR 0002 rule 2); otherwise the server swapped keys.
 */
function checkAgainstHeld(previous: SecretBundle | null, keys: KeySet): void {
	if (!previous || previous.accountId !== keys.accountId) return;
	if (!bytesEqual(previous.ik, keys.ik)) throw new ProtocolError("rotation_rejected", "The unlocked index key differs from the one this device holds");
	if (keys.vaultKeys.length < previous.vaultKeys.length) throw new ProtocolError("rollback", "The unlocked key set has fewer vault keys than this device holds");
	previous.vaultKeys.forEach((vk, i) => {
		if (!bytesEqual(vk, keys.vaultKeys[i] as Uint8Array)) throw new ProtocolError("rotation_rejected", `The unlocked vault key ${i + 1} differs from the one this device holds`);
	});
}

function acceptFromPairing(accountId: string, generation: number, rootKey: Uint8Array, k: KeysResponse): KeySet {
	// The root key is authenticated by approveTag (ADR 0002 rule 4); the wraps must open under it.
	const u = unwrapAll(accountId, generation, rootKey, k.epoch, wrapsFrom(k.wraps));
	return { accountId, generation, rootKey, ik: u.ik, vaultKeys: u.vaultKeys };
}

/**
 * Leaves the vault on this device (ADR 0007 "Leaving the vault"): deletes `local/vault/` with the
 * outbox and sync state and clears the secrets. The data folder stays as a plain LearnHarness data
 * folder. Returns the number of outbox entries that were never pushed, so the UI can warn first.
 */
export async function leaveVault(dataDir: string, storage: KeyStorage, opts: { dryRun?: boolean } = {}): Promise<{ unpushed: number }> {
	const { readFile, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const dir = join(dataDir, "local", "vault");
	let unpushed = 0;
	try {
		unpushed = (await readFile(join(dir, "outbox.jsonl"), "utf8")).split("\n").filter((l) => l.trim()).length;
	} catch {
		// no outbox
	}
	if (!opts.dryRun) {
		await rm(dir, { recursive: true, force: true });
		await storage.clear();
	}
	return { unpushed };
}
