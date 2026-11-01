/**
 * The vault runtime: the one module that statically imports the private vault client
 * (@znerual/learnharness-vault-client). Only service.ts loads it, with a dynamic import that
 * is allowed to fail, so a build without the package never evaluates this file.
 *
 * It owns what lives for the whole process while the learner is signed in:
 *   Vault (keys, token) → SyncEngine + LearnHarnessHost → wrapped stores (src/server/stores.ts
 *   reads them through ./active.ts).
 * The renderer never sees any of it; it calls the routes (./routes.ts).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkPassword, MemoryKeyStorage, Restorer, Vault, type KeyStorage } from "@znerual/learnharness-vault-client";

import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import { promptOverrides as plainPromptOverrides } from "../../store/prompt-overrides.ts";
import { plainStores, type Stores } from "../stores.ts";
import { setActiveVaultStores } from "./active.ts";
import { joinWithExistingData, seedFirstDevice, VaultNotEmptyError } from "./join.ts";
import { IpcKeyStorage } from "./keystorage-ipc.ts";
import { IpcPasskeys } from "./passkey-ipc.ts";
import { createVaultRoutes, type VaultRoutes } from "./routes.ts";
import { assertNotSyncthing } from "./syncthing.ts";
import { leaveLocalVault, wireVault, type WiredVault } from "./wire.ts";

/** `LH_VAULT_PASSWORD_CHECK=offline` skips the online breach lookup of sign-up passwords (offline setups, tests). */
const PASSWORD_CHECK = process.env.LH_VAULT_PASSWORD_CHECK === "offline" ? { offline: true } : {};

const IDLE = { state: "idle", pendingChanges: 0, lastSuccess: null, conflicts: 0, rollbacks: 0, rejected: 0 } as const;

/** What a first sign-in on this device did to the data folder; written once, beside the outbox. */
const BOOTSTRAP_FILE = "bootstrapped.json";

/** The routes that enable the vault on this device refuse a data folder that Syncthing shares (ADR 0001). */
const ENABLING = new Set<string | symbol>(["signupStart", "signIn", "open", "recover", "passkeySignInStart", "pairShowAsJoiner", "pairJoin"]);

/** The vault client's statics, with the Syncthing refusal in front of every route that enables the vault. */
function guarded(): typeof Vault {
	return new Proxy(Vault, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (ENABLING.has(key)) assertNotSyncthing(PATHS.data);
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

/** safeStorage through the Electron main process when there is one and it is secure, else session mode (memory).
 *  Only the desktop app's own server child (LH_DESKTOP_SERVER, electron/main.cjs) speaks the bridge: any other
 *  process with an IPC channel (a test runner, a dev launcher) would wait for an answer that never comes. */
async function chooseStorage(): Promise<{ storage: KeyStorage; ephemeral: boolean }> {
	const ipc = new IpcKeyStorage();
	if (process.env.LH_DESKTOP_SERVER === "1" && ipc.hasBridge && (await ipc.status()).available) return { storage: ipc, ephemeral: false };
	return { storage: new MemoryKeyStorage(), ephemeral: true };
}

function prefsFile(): string {
	return join(PATHS.local, "vault-prefs.json");
}

function readPrefs(): { exportReminder?: boolean } {
	try {
		return JSON.parse(readFileSync(prefsFile(), "utf8")) as { exportReminder?: boolean };
	} catch {
		return {};
	}
}

type Bootstrapped = { accountId: string };

function readBootstrap(): Bootstrapped | null {
	try {
		return JSON.parse(readFileSync(join(PATHS.local, "vault", BOOTSTRAP_FILE), "utf8")) as Bootstrapped;
	} catch {
		return null;
	}
}

/**
 * The first start on this device with this account (ADR 0007 "Joining with existing local data"):
 * a vault without records is seeded with the data folder; a vault that has records replaces what
 * this folder holds, which moves aside to <local>/pre-vault-<date>/ first and is never deleted.
 * There is no confirmation dialog yet (see the final report), so "Use the vault" is the only
 * path, the one the ADR names as the default for a device that signs in to an existing vault.
 */
async function bootstrap(wired: WiredVault<Stores>, vault: Vault): Promise<void> {
	const done = readBootstrap();
	if (done?.accountId === vault.accountId) return;
	// Outbox and state of another account (or a half-finished first start) must not leak into this one.
	rmSync(join(PATHS.local, "vault"), { recursive: true, force: true });
	await wired.engine.init();
	if ((await wired.host.listAllFiles()).length > 0) {
		try {
			await seedFirstDevice({ vault, engine: wired.engine });
		} catch (e) {
			if (!(e instanceof VaultNotEmptyError)) throw e;
			await joinWithExistingData({ vault, engine: wired.engine, host: wired.host, deviceId: plainStores.deviceStore.getDevice().id, choice: "use-vault" });
		}
	}
	mkdirSync(join(PATHS.local, "vault"), { recursive: true });
	writeFileSync(join(PATHS.local, "vault", BOOTSTRAP_FILE), JSON.stringify({ accountId: vault.accountId }));
}

export async function createVaultRuntime(serverUrl: string): Promise<VaultRoutes> {
	const { storage, ephemeral } = await chooseStorage();
	let wired: WiredVault<Stores> | null = null;
	let chain: Promise<unknown> = Promise.resolve();
	/** Start and stop never overlap: sign-in, unlock and pairing may all start the sync. */
	const serialized = <T>(f: () => Promise<T>): Promise<T> => {
		const run = chain.then(f, f);
		chain = run.catch(() => undefined);
		return run;
	};

	const stopWired = async (): Promise<void> => {
		setActiveVaultStores(null);
		wired?.stop();
		wired = null;
	};

	return createVaultRoutes({
		serverUrl,
		Vault: guarded(),
		options: () => {
			const device = plainStores.deviceStore.getDevice();
			return { serverUrl, storage, device: { lhDeviceId: device.id, name: device.name }, keysProtected: true, password: PASSWORD_CHECK, ...(ephemeral ? { ephemeral: true } : {}) };
		},
		checkPassword: (password) => checkPassword(password, PASSWORD_CHECK),
		passkeys: new IpcPasskeys({ serverUrl }),
		sync: {
			start: (vault) =>
				serialized(async () => {
					await stopWired();
					const next = wireVault<Stores>({
						stores: plainStores,
						dataDir: PATHS.data,
						localDir: PATHS.local,
						vault: vault as unknown as Vault,
						emit: (type, payload) => emit(type, payload as never),
						promptOverrides: plainPromptOverrides,
					});
					await bootstrap(next, vault as unknown as Vault);
					await next.start();
					wired = next;
					// From here on, writes through `stores` note their intent first.
					setActiveVaultStores({ ...next.stores, promptOverrides: next.promptOverrides });
				}),
			stop: () => serialized(stopWired),
			status: () => wired?.engine.status() ?? { ...IDLE },
			syncNow: async () => {
				if (!wired) return { ...IDLE };
				await wired.engine.sync();
				return wired.engine.status();
			},
		},
		restorer: (vault) => {
			if (!wired) throw new Error("the vault is not syncing");
			return new Restorer(vault as unknown as Vault, wired.engine, wired.host);
		},
		leaveVault: async ({ dryRun }) => {
			if (dryRun) return { unpushed: wired?.pendingCount() ?? (await leaveLocalVault(PATHS.local, storage, { dryRun: true })).unpushed };
			return leaveLocalVault(PATHS.local, storage);
		},
		exportReminder: {
			get: () => readPrefs().exportReminder ?? true,
			set: (enabled) => {
				mkdirSync(PATHS.local, { recursive: true });
				writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), exportReminder: enabled }));
			},
		},
	});
}

