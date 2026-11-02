import assert from "node:assert/strict";
import { test } from "node:test";
import { createVaultApi, errorCode, VaultApiError } from "../src/core/vault/api.ts";
import type { AccountResponse, DeviceRow, SyncStatus } from "../src/core/vault/deps.ts";
import { PasskeyError, type CeremonyOutcome, type PasskeyPort } from "../src/server/vault/passkey-ipc.ts";
import { createVaultRoutes, type StartPlan, toRouteError, type JoinerLike, type RestorerLike, type RotationDto, type VaultLike, type VaultRouteDeps, type VaultStatics } from "../src/server/vault/routes.ts";

const secret = (s: string) => ({ display: () => s });

const account: AccountResponse = {
	accountId: "acc", email: "learner@example.org", state: "active", canPush: true, billingEnabled: false, trialEndsAt: "x", graceEndsAt: null, quotaBytes: 1, usedBytes: 0, historyBytes: 0,
	generation: 1, epoch: 1, lastExportAt: null, createdAt: "2026-01-01T00:00:00Z", backupCodesLeft: 10, passkeys: 0, devices: 2, pendingAction: null, historyRetentionDays: 90,
};

class ApiErr extends Error {
	override name = "ApiError";
	constructor(readonly status: number, readonly code: string, readonly body: Record<string, unknown> = {}) {
		super(`${status} ${code}`);
	}
}

class FakeVault implements VaultLike {
	accountId = "acc";
	deviceId = "dev-me";
	ephemeral = false;
	mustSetPassword = false;
	calls: string[] = [];
	grantsSeen: string[] = [];
	rotation: RotationDto = { status: "applied", generation: 2 };
	api = {
		post: async <T>(path: string): Promise<T> => {
			this.calls.push(`api.post ${path}`);
			if (path === "/v1/billing/link") throw new ApiErr(404, "billing_disabled");
			return {} as T;
		},
	};
	auth() {
		return { token: "t" };
	}
	async account() {
		return account;
	}
	async devices(): Promise<DeviceRow[]> {
		return [{ id: "dev-me", lhDeviceId: "dev_me", name: "Me", ephemeral: false, keysProtected: true, createdAt: "x", lastSeenAt: "x", current: true, established: true, hasUnlockMethod: true }];
	}
	async renameDevice(id: string, name: string) {
		this.calls.push(`rename ${id} ${name}`);
	}
	async signOut() {
		this.calls.push("signOut");
	}
	async reauthPassword(p: string) {
		if (p !== "good") throw Object.assign(new Error("Wrong password"), { name: "VaultError", code: "login_failed" });
		return "grant-pw";
	}
	async reauthRecovery() {
		return "grant-rec";
	}
	async reauthPasskeyStart() {
		return { ceremonyId: "c", options: {} };
	}
	async reauthPasskeyFinish() {
		return "grant-pk";
	}
	async passkeyRegisterStart(grant: string) {
		this.grantsSeen.push(grant);
		return { ceremonyId: "reg1", options: { publicKey: { challenge: "x" } }, prfSalt: new Uint8Array([7, 7]) };
	}
	async passkeyRegisterFinish(_c: string, credential: unknown, name: string, prf: Uint8Array | null, grant: string) {
		this.grantsSeen.push(grant);
		this.calls.push(`passkeyFinish ${name} prf=${prf ? prf.length : "none"} cred=${JSON.stringify(credential)}`);
		return { passkeyId: "pk2", signInOnly: prf === null };
	}
	passkeyRows = [{ id: "pk1", name: "Laptop", signInOnly: false, methodId: "m1" }];
	async passkeys() {
		return this.passkeyRows;
	}
	async removePasskey(id: string, grant: string) {
		this.grantsSeen.push(grant);
		this.calls.push(`removePasskey ${id}`);
		return this.rotation;
	}
	async revokeDevice(id: string, grant: string) {
		this.grantsSeen.push(grant);
		this.calls.push(`revoke ${id}`);
		return this.rotation;
	}
	async confirmPending(id: string, grant: string) {
		this.grantsSeen.push(grant);
		this.calls.push(`confirm ${id}`);
	}
	async cancelPending(id: string, grant: string) {
		this.grantsSeen.push(grant);
		this.calls.push(`cancel ${id}`);
	}
	async changePassword(_p: string, grant: string) {
		this.grantsSeen.push(grant);
		return this.rotation;
	}
	async setNewPassword() {
		this.calls.push("setNewPassword");
		return this.rotation;
	}
	async regenerateRecoveryKey(grant: string) {
		this.grantsSeen.push(grant);
		return { ...this.rotation, recoveryKey: secret("RK-NEW") };
	}
	async regenerateBackupCodes(grant: string) {
		this.grantsSeen.push(grant);
		return { ...this.rotation, backupCodes: [secret("BC-1"), secret("BC-2")] };
	}
	emergencyKit(email: string, rk: { display(): string }) {
		return { email, serverUrl: "https://vault.example", recoveryKey: rk.display(), recoveryKeyQr: "qr", createdAt: "2026-11-01T00:00:00Z" };
	}
	async deleteAccount(grant: string) {
		this.grantsSeen.push(grant);
		this.calls.push("deleteAccount");
	}
	async pairShow() {
		return { pairingId: "pair1", qr: "lhv1-pair:x", text: "T".repeat(52), secret: new Uint8Array([1, 2, 3]) };
	}
	async pairReview(id: string, s: Uint8Array) {
		this.calls.push(`review ${id} ${s.length}`);
		return { name: "New phone", code: "123456", publicKey: new Uint8Array([9]) };
	}
	async pairApprove(id: string, _s: Uint8Array, pk: Uint8Array) {
		this.calls.push(`approve ${id} ${pk[0]}`);
	}
	async downloadExport() {
		return new Uint8Array([1, 2, 3]);
	}
}

/** A passkey port that records its requests and answers with the next queued outcome or error. */
class FakePasskeys implements PasskeyPort {
	available = true;
	requests: { op: "create" | "get"; options: unknown; salt?: Uint8Array | undefined }[] = [];
	next: CeremonyOutcome | PasskeyError = { credential: { id: "cred" }, prfOutput: new Uint8Array(32).fill(5), prfEnabled: true };
	availability() {
		return this.available ? ({ available: true } as const) : ({ available: false, reason: "bridge_missing" } as const);
	}
	private answer(op: "create" | "get", options: unknown, salt?: Uint8Array): Promise<CeremonyOutcome> {
		this.requests.push({ op, options, salt });
		return this.next instanceof PasskeyError ? Promise.reject(this.next) : Promise.resolve(this.next);
	}
	create(options: unknown, salt: Uint8Array) {
		return this.answer("create", options, salt);
	}
	get(options: unknown, salt?: Uint8Array) {
		return this.answer("get", options, salt);
	}
}

interface World {
	routes: ReturnType<typeof createVaultRoutes>;
	vault: FakeVault;
	log: string[];
	sync: { started: number; stopped: number };
	clock: { t: number };
	passkeys: FakePasskeys;
	/** What `sync.plan` answers; null: not a first start. */
	plan: { value: StartPlan | null };
	starts: { choice?: "use-vault" | "merge" | undefined }[];
}

function world(over: Partial<VaultStatics> = {}, migration?: VaultRouteDeps["migration"]): World {
	const vault = new FakeVault();
	const passkeys = new FakePasskeys();
	const log: string[] = [];
	const sync = { started: 0, stopped: 0 };
	const clock = { t: 1_000_000 };
	const plan: { value: StartPlan | null } = { value: null };
	const starts: { choice?: "use-vault" | "merge" | undefined }[] = [];
	let confirmed: string | null = null;
	const joiner: JoinerLike = { pairingId: "jp", code: "654321", qr: "lhv1-pair:j", text: "J".repeat(52), finish: async () => vault };
	const Vault: VaultStatics = {
		signupStart: async (_u, e) => void log.push(`signupStart ${e}`),
		signupVerify: async (_u, email) => ({ email }),
		signupFinish: async () => ({ vault, display: { recoveryKey: secret("ABCD-EFGH"), backupCodes: [secret("CODE-1"), secret("CODE-2")] }, kit: vault.emergencyKit("learner@example.org", secret("ABCD-EFGH")) }),
		confirmRecoveryMaterial: (_d, typed) => (confirmed = typed) === "GH" || typed === "CODE-1",
		signIn: async (_o, _e, p) => {
			if (p !== "pw") throw Object.assign(new Error("Wrong email or password"), { name: "VaultError", code: "login_failed" });
			return vault;
		},
		open: async () => vault,
		recover: async () => {
			vault.mustSetPassword = true;
			return vault;
		},
		passkeySignInStart: async () => ({ ceremonyId: "c1", options: { challenge: "x" } }),
		passkeySignInFinish: async (_o, _c, _cred, prf) => (prf ? { status: "unlocked", vault } : { status: "needs_unlock", session: { deviceToken: "t" } }),
		unlockSessionWithPassword: async () => vault,
		pairShowAsJoiner: async () => joiner,
		pairJoin: async () => joiner,
		parsePairingCode: (code) => {
			const [, url, id] = /^lhv1-pair:(https:\/\/[^ ]+) ([^ ]+)$/.exec(code) ?? [];
			if (!url || !id) throw Object.assign(new Error("bad"), { name: "VaultError", code: "bad_code" });
			return { serverUrl: url, pairingId: id, secret: new Uint8Array([7, 7]) };
		},
		...over,
	};
	void confirmed;
	const restorer: RestorerLike = {
		versions: async () => [{ seq: 2, createdAt: "x", deviceName: "d", deleted: false, size: 3 }],
		restoreVersion: async (p, s) => void log.push(`restoreVersion ${p} ${s}`),
		preview: async (at) => [{ path: "a.md", change: "changed" as const, extra: at.toISOString() } as { path: string; change: "changed" }],
		restoreTo: async () => [{ path: "a.md", change: "removed" }],
	};
	const status: SyncStatus = { state: "idle", pendingChanges: 0, lastSuccess: null, conflicts: 0, rollbacks: 0, rejected: 0 };
	let reminder = true;
	const deps: VaultRouteDeps = {
		serverUrl: "https://vault.example",
		Vault,
		options: () => ({ opts: true }),
		checkPassword: async (p) => (p.length < 12 ? { ok: false, reason: "too_short" } : { ok: true, onlineChecked: false }),
		sync: {
			start: (_v, o) => {
				sync.started++;
				starts.push({ choice: o?.choice });
			},
			stop: () => void sync.stopped++,
			status: () => status,
			syncNow: async () => status,
			plan: async () => plan.value ?? { firstStart: false, localFiles: 0, vaultHasRecords: false },
		},
		...(migration ? { migration } : {}),
		restorer: () => restorer,
		leaveVault: async (o) => ({ unpushed: o.dryRun ? 3 : 0 }),
		exportReminder: { get: () => reminder, set: (b) => void (reminder = b) },
		passkeys,
		now: () => clock.t,
	};
	return { routes: createVaultRoutes(deps), vault, log, sync, clock, passkeys, plan, starts };
}

async function call(w: World, method: string, path: string, body?: unknown, query?: Record<string, string>) {
	return w.routes.handle({ method, path, body, ...(query ? { query } : {}) });
}

test("unknown route and wrong method", async () => {
	const w = world();
	assert.equal((await call(w, "GET", "/nope")).status, 404);
	assert.equal((await call(w, "DELETE", "/session")).status, 405);
});

test("routes need a session", async () => {
	const w = world();
	const r = await call(w, "GET", "/devices");
	assert.equal(r.status, 401);
	assert.deepEqual(r.body, { error: "no_session", message: "Not signed in" });
	assert.deepEqual((await call(w, "GET", "/session")).body, { state: "signed_out" });
});

test("signup: start, verify, finish returns secrets once, confirm clears them", async () => {
	const w = world();
	assert.equal((await call(w, "POST", "/signup/start", { email: "learner@example.org" })).status, 200);
	assert.equal((await call(w, "POST", "/signup/finish", { password: "x" })).status, 409, "needs verify first");
	await call(w, "POST", "/signup/verify", { email: "learner@example.org", code: "ABCD1234" });
	const fin = await call(w, "POST", "/signup/finish", { password: "a-long-password-1" });
	const body = fin.body as { display: { recoveryKey: string; backupCodes: string[] }; kit: { recoveryKey: string } };
	assert.equal(fin.status, 200);
	assert.equal(body.display.recoveryKey, "ABCD-EFGH");
	assert.deepEqual(body.display.backupCodes, ["CODE-1", "CODE-2"]);
	assert.equal(w.sync.started, 1, "sync starts after signup");
	assert.deepEqual((await call(w, "POST", "/signup/confirm", { typed: "nope" })).body, { ok: false });
	assert.deepEqual((await call(w, "POST", "/signup/confirm", { typed: "CODE-1" })).body, { ok: true });
	assert.equal((await call(w, "POST", "/signup/confirm", { typed: "CODE-1" })).status, 409, "secrets are gone from server memory");
});

test("the session route never exposes keys or tokens", async () => {
	const w = world();
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	const r = await call(w, "GET", "/session");
	assert.deepEqual(r.body, { state: "signed_in", accountId: "acc", deviceId: "dev-me", ephemeral: false, offline: false });
	assert.doesNotMatch(JSON.stringify(r.body), /token|key|grant/i);
});

test("password sign-in: wrong password is 401 login_failed", async () => {
	const w = world();
	const r = await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "bad" });
	assert.equal(r.status, 401);
	assert.equal((r.body as { error: string }).error, "login_failed");
	assert.equal(w.sync.started, 0);
});

test("passkey sign-in: the server runs the ceremony; with PRF it unlocks, without PRF it needs unlock then password", async () => {
	const w = world();
	w.passkeys.next = { credential: { id: "c" }, prfOutput: null, prfEnabled: false };
	const noPrf = await call(w, "POST", "/sign-in/passkey", { email: "Learner@Example.org" });
	assert.deepEqual(noPrf.body, { state: "needs_unlock", email: "learner@example.org" });
	assert.deepEqual(w.passkeys.requests, [{ op: "get", options: { challenge: "x" }, salt: undefined }]);
	assert.equal(w.sync.started, 0);
	const unlock = await call(w, "POST", "/unlock/password", { password: "pw" });
	assert.equal((unlock.body as { state: string }).state, "signed_in");
	assert.equal(w.sync.started, 1);
	const w2 = world();
	const withPrf = await call(w2, "POST", "/sign-in/passkey", { email: "a@b.co" });
	assert.equal((withPrf.body as { state: string }).state, "signed_in");
	assert.equal((await call(world(), "POST", "/unlock/password", { password: "pw" })).status, 409);
});

test("passkey sign-in: unavailable bridge is 503, a closed window 409, neither starts sync", async () => {
	const w = world();
	w.passkeys.available = false;
	const r = await call(w, "POST", "/sign-in/passkey", { email: "a@b.co" });
	assert.deepEqual([r.status, (r.body as { error: string }).error], [503, "passkey_unavailable"]);
	assert.equal(w.passkeys.requests.length, 0);
	const w2 = world();
	w2.passkeys.next = new PasskeyError("passkey_cancelled");
	const c = await call(w2, "POST", "/sign-in/passkey", { email: "a@b.co" });
	assert.deepEqual([c.status, (c.body as { error: string }).error], [409, "passkey_cancelled"]);
	assert.equal(w2.sync.started, 0);
	assert.deepEqual((await call(w2, "GET", "/passkeys/availability")).body, { available: true });
	assert.deepEqual((await call(w, "GET", "/passkeys/availability")).body, { available: false, reason: "bridge_missing" });
});

test("passkey re-authentication: the ceremony stays on the server and yields a handle, not a credential", async () => {
	const w = world();
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	const r = await call(w, "POST", "/reauth/passkey");
	assert.equal(r.status, 200);
	const body = r.body as { reauthId: string; strength: string };
	assert.equal(body.strength, "passkey");
	assert.doesNotMatch(JSON.stringify(r.body), /grant-pk|cred|prf/i);
	assert.equal((await call(w, "POST", "/account/password", { password: "a-new-long-password", reauthId: body.reauthId })).status, 200);
	assert.deepEqual(w.vault.grantsSeen, ["grant-pk"]);
});

test("passkeys: list, register with one grant for both calls, and the response carries no credential or PRF", async () => {
	const w = world();
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	const list = await call(w, "GET", "/passkeys");
	assert.deepEqual(list.body, { availability: { available: true }, passkeys: [{ id: "pk1", name: "Laptop", signInOnly: false }] });
	assert.equal((await call(w, "POST", "/passkeys", { name: "Key", reauthId: "nope" })).status, 403);
	const { reauthId } = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	const r = await call(w, "POST", "/passkeys", { name: "  Phone key  ", reauthId });
	assert.deepEqual(r.body, { id: "pk2", name: "Phone key", signInOnly: false });
	assert.deepEqual(w.vault.grantsSeen, ["grant-pw", "grant-pw"], "one grant, used for start and finish");
	assert.equal(w.passkeys.requests.at(-1)?.op, "create");
	assert.deepEqual([...(w.passkeys.requests.at(-1)?.salt ?? [])], [7, 7]);
	assert.match(w.vault.calls.at(-1) ?? "", /passkeyFinish Phone key prf=32/);
	assert.equal((await call(w, "POST", "/passkeys", { name: "Again", reauthId })).status, 403, "the grant is single-use");
});

test("passkeys: a key without PRF registers as sign-in only; a cancelled window registers nothing", async () => {
	const w = world();
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	w.passkeys.next = { credential: {}, prfOutput: null, prfEnabled: false };
	const g = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	assert.equal(((await call(w, "POST", "/passkeys", { name: "Plain key", reauthId: g.reauthId })).body as { signInOnly: boolean }).signInOnly, true);
	w.passkeys.next = new PasskeyError("passkey_cancelled");
	const g2 = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	const c = await call(w, "POST", "/passkeys", { name: "x", reauthId: g2.reauthId });
	assert.equal(c.status, 409);
	assert.equal(w.vault.calls.filter((x) => x.startsWith("passkeyFinish")).length, 1);
	w.passkeys.available = false;
	const g3 = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	assert.equal((await call(w, "POST", "/passkeys", { name: "x", reauthId: g3.reauthId })).status, 503);
	assert.equal((await call(w, "POST", "/passkeys", { name: " ", reauthId: g3.reauthId })).status, 400);
});

test("passkeys: remove needs a grant and returns the rotation (applied or waiting 24 h)", async () => {
	const w = world();
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	assert.equal((await call(w, "DELETE", "/passkeys/pk1", { reauthId: "nope" })).status, 403);
	const g = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	assert.deepEqual((await call(w, "DELETE", "/passkeys/pk1", { reauthId: g.reauthId })).body, { status: "applied", generation: 2 });
	assert.ok(w.vault.calls.includes("removePasskey pk1"));
});

test("recovery: signed in but must set a password, sync stays off until it is set", async () => {
	const w = world();
	const r = await call(w, "POST", "/recover", { email: "learner@example.org", secret: "ABCD-EFGH-JKMN-PQRS" });
	assert.deepEqual(r.body, { state: "must_set_password" });
	assert.equal(w.sync.started, 0);
	await call(w, "POST", "/recover/new-password", { password: "a-new-long-password" });
	assert.equal(w.sync.started, 1);
	assert.equal(w.vault.mustSetPassword, false);
});

test("open on launch adopts the stored vault and starts sync", async () => {
	const w = world();
	const r = await call(w, "POST", "/session/open");
	assert.equal((r.body as { state: string }).state, "signed_in");
	assert.equal(w.sync.started, 1);
	const none = world({ open: async () => null });
	assert.deepEqual((await call(none, "POST", "/session/open")).body, { state: "signed_out" });
});

test("password check passes through the client's checkPassword", async () => {
	const w = world();
	assert.deepEqual((await call(w, "POST", "/password/check", { password: "short" })).body, { ok: false, reason: "too_short" });
	assert.deepEqual((await call(w, "POST", "/password/check", { password: "long-enough-password" })).body, { ok: true, onlineChecked: false });
	assert.equal((await call(w, "POST", "/password/check", {})).status, 400);
});

async function signedIn(w: World) {
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
}

test("revoke needs a grant; the grant is single-use; the result comes back as pending", async () => {
	const w = world();
	await signedIn(w);
	assert.equal((await call(w, "POST", "/devices/lost/revoke", { reauthId: "bogus" })).status, 403);
	const g = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string; strength: string };
	assert.equal(g.strength, "password");
	assert.doesNotMatch(g.reauthId, /grant-pw/);
	w.vault.rotation = { status: "pending", pendingAction: { id: "p1", kind: "revoke_device", strength: "password", requestedBy: "dev-me", requestedByName: "Me", targetDeviceId: "lost", runsAt: "2026-11-02T00:00:00Z", createdAt: "x", cancellable: true } };
	const r = await call(w, "POST", "/devices/lost/revoke", { reauthId: g.reauthId });
	assert.equal(r.status, 200);
	assert.equal((r.body as RotationDto).status, "pending");
	assert.deepEqual(w.vault.grantsSeen, ["grant-pw"]);
	assert.equal((await call(w, "POST", "/devices/lost/revoke", { reauthId: g.reauthId })).status, 403, "grant already used");
});

test("revoke with recovery material applies immediately; revoking this device is refused", async () => {
	const w = world();
	await signedIn(w);
	const g = (await call(w, "POST", "/reauth/recovery", { secret: "CODE" })).body as { reauthId: string; strength: string };
	assert.equal(g.strength, "recovery");
	assert.equal(((await call(w, "POST", "/devices/lost/revoke", { reauthId: g.reauthId })).body as RotationDto).status, "applied");
	const g2 = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	assert.equal((await call(w, "POST", "/devices/dev-me/revoke", { reauthId: g2.reauthId })).status, 400);
});

test("an expired grant is refused", async () => {
	const w = world();
	await signedIn(w);
	const g = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	w.clock.t += 6 * 60_000;
	assert.equal((await call(w, "POST", "/devices/lost/revoke", { reauthId: g.reauthId })).status, 403);
});

test("a wrong re-authentication password is 401 and issues no grant", async () => {
	const w = world();
	await signedIn(w);
	const r = await call(w, "POST", "/reauth/password", { password: "bad" });
	assert.equal(r.status, 401);
});

test("devices route returns rows and the pending action; rename, confirm, cancel map to client calls", async () => {
	const w = world();
	await signedIn(w);
	const d = (await call(w, "GET", "/devices")).body as { devices: DeviceRow[]; pendingAction: unknown };
	assert.equal(d.devices.length, 1);
	assert.equal(d.pendingAction, null);
	await call(w, "PATCH", "/devices/dev-x", { name: "Spare" });
	assert.equal((await call(w, "POST", "/pending/p9/confirm", { reauthId: "bogus" })).status, 403);
	const g1 = (await call(w, "POST", "/reauth/recovery", { secret: "CODE" })).body as { reauthId: string };
	await call(w, "POST", "/pending/p9/confirm", { id: "p9", reauthId: g1.reauthId });
	const g2 = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	await call(w, "POST", "/pending/p9/cancel", { id: "p9", reauthId: g2.reauthId });
	assert.deepEqual(w.vault.calls.filter((c) => !c.startsWith("api")), ["rename dev-x Spare", "confirm p9", "cancel p9"]);
});

test("sign out stops sync, signs the device out and forgets the vault", async () => {
	const w = world();
	await signedIn(w);
	await call(w, "POST", "/session/sign-out");
	assert.equal(w.sync.stopped, 1);
	assert.ok(w.vault.calls.includes("signOut"));
	assert.deepEqual((await call(w, "GET", "/session")).body, { state: "signed_out" });
});

test("regenerate returns the new secrets once, with the emergency kit for the recovery key", async () => {
	const w = world();
	await signedIn(w);
	const g1 = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	const rk = (await call(w, "POST", "/account/recovery-key", { reauthId: g1.reauthId })).body as { recoveryKey: string; kit: { email: string; recoveryKey: string }; rotation: RotationDto };
	assert.equal(rk.recoveryKey, "RK-NEW");
	assert.equal(rk.kit.email, "learner@example.org");
	assert.equal(rk.rotation.status, "applied");
	assert.equal("recoveryKey" in rk.rotation, false);
	const g2 = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	const bc = (await call(w, "POST", "/account/backup-codes", { reauthId: g2.reauthId })).body as { backupCodes: string[] };
	assert.deepEqual(bc.backupCodes, ["BC-1", "BC-2"]);
});

test("history documents: needs a signed-in device, lists what the runtime finds", async () => {
	const w = world();
	assert.equal((await call(w, "GET", "/history/documents")).status, 401);
	await signedIn(w);
	assert.deepEqual((await call(w, "GET", "/history/documents")).body, { documents: [] }, "no lister: an empty list");
});

test("pairing: show keeps the secret on the server, review then approve", async () => {
	const w = world();
	await signedIn(w);
	const shown = (await call(w, "POST", "/pairing/show")).body as Record<string, unknown>;
	assert.deepEqual(Object.keys(shown).sort(), ["pairingId", "qr", "text"], "the raw secret bytes are not returned");
	assert.equal((await call(w, "POST", "/pairing/pair1/approve")).status, 409, "approve needs a review first");
	const rev = (await call(w, "GET", "/pairing/pair1/review")).body;
	assert.deepEqual(rev, { name: "New phone", code: "123456" });
	assert.equal((await call(w, "POST", "/pairing/pair1/approve")).status, 200);
	assert.deepEqual(w.vault.calls.filter((c) => /review|approve/.test(c)), ["review pair1 3", "approve pair1 9"]);
	assert.equal((await call(w, "GET", "/pairing/unknown/review")).status, 404);
});

test("pairing: a signed-in device scans the code a new device shows, then reviews and approves", async () => {
	const w = world();
	assert.equal((await call(w, "POST", "/pairing/approver/scan", { code: "lhv1-pair:https://vault.example jp2" })).status, 401, "needs a signed-in device");
	await signedIn(w);
	assert.equal((await call(w, "POST", "/pairing/approver/scan", { code: "ABCD" })).status, 400, "only a full lhv1-pair: code");
	assert.equal((await call(w, "POST", "/pairing/approver/scan", { code: "lhv1-pair:https://other.example jp2" })).status, 400, "another server's code");
	const r = await call(w, "POST", "/pairing/approver/scan", { code: "lhv1-pair:https://vault.example/ jp2" });
	assert.deepEqual(r.body, { pairingId: "jp2" }, "the secret stays on the server");
	assert.equal((await call(w, "GET", "/pairing/jp2/review")).status, 200);
	assert.equal((await call(w, "POST", "/pairing/jp2/approve")).status, 200);
	assert.deepEqual(w.vault.calls.filter((c) => /review|approve/.test(c)), ["review jp2 2", "approve jp2 9"]);
});

test("pairing as joiner: show own code, then finish signs this device in and starts sync", async () => {
	const w = world();
	const shown = (await call(w, "POST", "/pairing/joiner/show")).body as { code: string; pairingId: string };
	assert.equal(shown.code, "654321");
	const fin = await call(w, "POST", `/pairing/${shown.pairingId}/finish`);
	assert.equal((fin.body as { state: string }).state, "signed_in");
	assert.equal(w.sync.started, 1);
	const w2 = world();
	const j = (await call(w2, "POST", "/pairing/joiner/join", { code: "lhv1-pair:x" })).body as { pairingId: string; code: string };
	assert.equal(j.code, "654321");
});

test("history routes: versions, restore one, preview and restore all drop internals", async () => {
	const w = world();
	await signedIn(w);
	assert.equal(((await call(w, "GET", "/history/versions", undefined, { path: "a.md" })).body as { versions: unknown[] }).versions.length, 1);
	await call(w, "POST", "/history/restore-version", { path: "a.md", seq: "2" });
	assert.deepEqual(w.log.filter((l) => l.startsWith("restoreVersion")), ["restoreVersion a.md 2"]);
	const prev = await call(w, "GET", "/history/preview", undefined, { at: "2026-10-20T10:00:00Z" });
	assert.deepEqual(prev.body, { plan: [{ path: "a.md", change: "changed" }] });
	assert.equal((await call(w, "GET", "/history/preview", undefined, { at: "not a date" })).status, 400);
	assert.deepEqual((await call(w, "POST", "/history/restore", { at: "2026-10-20T10:00:00Z" })).body, { plan: [{ path: "a.md", change: "removed" }] });
});

test("export returns a tar as base64 and the reminder setting round-trips", async () => {
	const w = world();
	await signedIn(w);
	const e = (await call(w, "POST", "/export")).body as { filename: string; dataBase64: string; contentType: string };
	assert.match(e.filename, /^lhv-export-\d{8}\.tar$/);
	assert.equal(e.contentType, "application/x-tar");
	assert.deepEqual([...Buffer.from(e.dataBase64, "base64")], [1, 2, 3]);
	assert.deepEqual((await call(w, "GET", "/export/reminder")).body, { enabled: true });
	assert.deepEqual((await call(w, "PUT", "/export/reminder", { enabled: false })).body, { enabled: false });
	assert.deepEqual((await call(w, "GET", "/export/reminder")).body, { enabled: false });
	assert.equal((await call(w, "PUT", "/export/reminder", { enabled: "no" })).status, 400);
});

test("manage plan maps billing_disabled to 404", async () => {
	const w = world();
	await signedIn(w);
	const r = await call(w, "POST", "/account/plan-link");
	assert.equal(r.status, 404);
	assert.equal((r.body as { error: string }).error, "billing_disabled");
});

test("delete account: needs the typed email and a grant, then forgets the session", async () => {
	const w = world();
	await signedIn(w);
	const g = (await call(w, "POST", "/reauth/password", { password: "good" })).body as { reauthId: string };
	assert.equal((await call(w, "DELETE", "/account", { email: "someone@else.org", reauthId: g.reauthId })).status, 400);
	const ok = await call(w, "DELETE", "/account", { email: "LEARNER@example.org", reauthId: g.reauthId });
	assert.equal(ok.status, 200);
	assert.deepEqual(w.vault.grantsSeen, ["grant-pw"]);
	assert.equal(w.sync.stopped, 1);
	assert.equal((await call(w, "GET", "/account")).status, 401);
});

test("leave vault: a dry run reports unpushed changes and keeps the session", async () => {
	const w = world();
	await signedIn(w);
	assert.deepEqual((await call(w, "POST", "/session/leave", { dryRun: true })).body, { unpushed: 3 });
	assert.equal((await call(w, "GET", "/session")).status, 200);
	assert.equal(w.sync.stopped, 0);
	await call(w, "POST", "/session/leave", {});
	assert.equal(w.sync.stopped, 1);
	assert.deepEqual((await call(w, "GET", "/session")).body, { state: "signed_out" });
});

test("error mapping: ApiError, NetworkError, VaultError and unknown errors", () => {
	assert.deepEqual([toRouteError(new ApiErr(403, "reauth_required", { message: "m" })).status, toRouteError(new ApiErr(403, "reauth_required", { message: "m" })).message], [403, "m"]);
	assert.equal(toRouteError(Object.assign(new Error("x"), { name: "NetworkError" })).status, 503);
	assert.equal(toRouteError(Object.assign(new Error("x"), { name: "VaultError", code: "password_breached" })).status, 422);
	assert.equal(toRouteError(Object.assign(new Error("x"), { name: "VaultError", code: "pairing_cancelled" })).status, 409);
	const u = toRouteError(new Error("secret internals"));
	assert.equal(u.status, 500);
	assert.doesNotMatch(u.message, /secret internals/);
});

test("the renderer API client talks to the routes end to end", async () => {
	const w = world();
	const api = createVaultApi({
		base: "/api/vault",
		fetch: async (url, init) => {
			const u = new URL(url, "http://x");
			const r = await w.routes.handle({
				method: init?.method ?? "GET",
				path: u.pathname.replace(/^\/api\/vault/, ""),
				query: Object.fromEntries(u.searchParams),
				body: init?.body ? JSON.parse(init.body as string) : undefined,
			});
			return new Response(JSON.stringify(r.body), { status: r.status });
		},
	});
	assert.deepEqual(await api.session(), { state: "signed_out" });
	await assert.rejects(api.devices(), (e) => e instanceof VaultApiError && e.status === 401 && errorCode(e) === "no_session");
	await api.signIn({ email: "learner@example.org", password: "pw" });
	await api.renameDevice({ deviceId: "dev-x", name: "Spare" });
	assert.ok(w.vault.calls.includes("rename dev-x Spare"));
	const prev = await api.historyPreview({ at: "2026-10-20T10:00:00Z" });
	assert.equal(prev.plan[0]?.path, "a.md");
	assert.equal(errorCode(new Error("x")), "generic");
});

// ---------------------------------------------------------------- joining

test("joining: a first sign-in with local data into a vault with records asks first and starts nothing", async () => {
	const w = world();
	w.plan.value = { firstStart: true, localFiles: 12, vaultHasRecords: true };
	const r = await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	assert.deepEqual(r.body, { state: "joining", email: "learner@example.org", localFiles: 12 });
	assert.equal(w.sync.started, 0, "no sync and no moved files before the answer");
	assert.deepEqual((await call(w, "GET", "/session")).body, { state: "joining", email: "learner@example.org", localFiles: 12 });
	assert.equal((await call(w, "POST", "/session/join", { choice: "nope" })).status, 400);
	const ok = await call(w, "POST", "/session/join", { choice: "use-vault" });
	assert.equal((ok.body as { state: string }).state, "signed_in");
	assert.deepEqual(w.starts, [{ choice: "use-vault" }], "the choice reaches the start");
	assert.equal((await call(w, "POST", "/session/join", { choice: "use-vault" })).status, 409, "nothing left to confirm");
});

test("joining: cancel signs out, forgets the session and never starts the sync", async () => {
	const w = world();
	w.plan.value = { firstStart: true, localFiles: 3, vaultHasRecords: true };
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	const r = await call(w, "POST", "/session/join", { choice: "cancel" });
	assert.deepEqual(r.body, { state: "signed_out" });
	assert.equal(w.sync.started, 0);
	assert.ok(w.vault.calls.includes("signOut"));
	assert.equal((await call(w, "GET", "/devices")).status, 401);
});

test("joining: no question without local data, into an empty vault, or after the first start", async () => {
	for (const plan of [
		{ firstStart: true, localFiles: 0, vaultHasRecords: true },
		{ firstStart: true, localFiles: 5, vaultHasRecords: false },
		{ firstStart: false, localFiles: 5, vaultHasRecords: true },
	]) {
		const w = world();
		w.plan.value = plan;
		const r = await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
		assert.equal((r.body as { state: string }).state, "signed_in", JSON.stringify(plan));
		assert.equal(w.sync.started, 1);
	}
});

test("joining: a new device that paired shows the join screen before it syncs, even with nothing to ask", async () => {
	const w = world();
	w.plan.value = { firstStart: true, localFiles: 0, vaultHasRecords: true };
	await call(w, "POST", "/pairing/joiner/show");
	const r = await call(w, "POST", "/pairing/jp/finish");
	assert.deepEqual(r.body, { state: "joining", email: "learner@example.org", localFiles: 0 });
	assert.equal(w.sync.started, 0);
	assert.equal(((await call(w, "POST", "/session/join", { choice: "use-vault" })).body as { state: string }).state, "signed_in");
	assert.equal(w.sync.started, 1);
	// pairing again into an account that already started here goes straight on
	const again = world();
	again.plan.value = { firstStart: false, localFiles: 0, vaultHasRecords: true };
	await call(again, "POST", "/pairing/joiner/show");
	assert.equal(((await call(again, "POST", "/pairing/jp/finish")).body as { state: string }).state, "signed_in");
});

test("joining: signing out while the question is open stops everything; an offline plan falls back to a plain start", async () => {
	const w = world();
	w.plan.value = { firstStart: true, localFiles: 2, vaultHasRecords: true };
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	assert.equal((await call(w, "POST", "/session/sign-out")).status, 200);
	assert.deepEqual((await call(w, "GET", "/session")).body, { state: "signed_out" });
});

test("a start that would move local files without the learner's answer is a 409 join_choice_required", () => {
	const e = toRouteError(Object.assign(new Error("ask first"), { name: "JoinChoiceRequiredError" }));
	assert.deepEqual([e.status, e.code], [409, "join_choice_required"]);
});

// ---------------------------------------------------------------- moving local data in (docs/vault-migration.md)

test("joining: the merge choice reaches the start like use-vault does", async () => {
	const w = world();
	w.plan.value = { firstStart: true, localFiles: 4, vaultHasRecords: true };
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	assert.equal((await call(w, "POST", "/session/join", { choice: "merge" })).status, 200);
	assert.deepEqual(w.starts, [{ choice: "merge" }]);
});

test("migration routes: report and Syncthing set-aside work signed out; merge needs a session and a name; no deps means 503", async () => {
	const calls: string[] = [];
	const state = { report: { layout: "older", graphFormat: 1, counts: { sessions: 1, jobs: 0, ledgerFiles: 0, prompts: 0, conflicts: 0 }, steps: [], conflicts: [], unreadable: [], blocked: null, syncthing: [], needed: true }, syncthing: { needed: false, markers: [], steps: [] }, lastUpgrade: null, movedAside: [{ name: "pre-vault-20261101", sessions: 2, files: 5, merged: false }] };
	const w = world({}, {
		report: async () => state as never,
		setAsideSyncthing: async () => (calls.push("aside"), { moved: [".stfolder"], remaining: [] }),
		merge: async (name) => (calls.push(`merge ${name}`), { from: name } as never),
	});
	assert.deepEqual((await call(w, "GET", "/migration/report")).body, state);
	assert.equal((await call(w, "POST", "/migration/syncthing/set-aside", {})).status, 400, "the learner's confirmation is required");
	assert.deepEqual((await call(w, "POST", "/migration/syncthing/set-aside", { confirmed: true })).body, { moved: [".stfolder"], remaining: [] });
	assert.equal((await call(w, "POST", "/migration/merge", { name: "pre-vault-20261101" })).status, 401);
	await call(w, "POST", "/sign-in/password", { email: "learner@example.org", password: "pw" });
	assert.equal((await call(w, "POST", "/migration/merge", {})).status, 400);
	assert.equal((await call(w, "POST", "/migration/merge", { name: "pre-vault-20261101" })).status, 200);
	assert.deepEqual(calls, ["aside", "merge pre-vault-20261101"]);
	const none = world();
	assert.equal((await call(none, "GET", "/migration/report")).status, 503);
});

test("a newer app's data answers data_newer", () => {
	const e = Object.assign(new Error("newer"), { name: "MigrationRefusedError" });
	assert.deepEqual([toRouteError(e).status, toRouteError(e).code], [409, "data_newer"]);
});
