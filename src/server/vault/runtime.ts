/**
 * The vault runtime: the one module that statically imports the vault client
 * (@znerual/learnharness-vault-client, packages/vault-client). Only service.ts loads it, with a
 * dynamic import, so the client and its WASM crypto load only while the vault is switched on.
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
import type { JoinChoice, MigrationStateDto } from "../../core/vault/migration.ts";
import { listMovedAside, mergePreVault } from "../migration/merge.ts";
import { planSwitch, setAsideMarkers } from "../migration/syncthing.ts";
import { readJournal, scanDataFolder, upgradeDataFolder } from "../migration/upgrade.ts";
import { emit } from "../../core/events.ts";
import { promptOverrides as plainPromptOverrides } from "../../store/prompt-overrides.ts";
import { plainStores, type Stores } from "../stores.ts";
import { setActiveVaultStores } from "./active.ts";
import { LearnHarnessHost } from "./host.ts";
import { joinWithExistingData, seedFirstDevice, vaultIsEmpty, VaultNotEmptyError } from "./join.ts";
import { AndroidKeyStorage } from "./keystorage-android.ts";
import { IpcKeyStorage } from "./keystorage-ipc.ts";
import { AndroidPasskeys } from "./passkey-android.ts";
import { IpcPasskeys } from "./passkey-ipc.ts";
import { listHistoryDocuments } from "./documents.ts";
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

/** safeStorage through the Electron main process when there is one and it is secure, the Android Keystore
 *  when the Android shell serves its bridge (LH_KEYSTORE_URL), else session mode (memory).
 *  Only the desktop app's own server child (LH_DESKTOP_SERVER, electron/main.cjs) speaks the bridge: any other
 *  process with an IPC channel (a test runner, a dev launcher) would wait for an answer that never comes. */
async function chooseStorage(): Promise<{ storage: KeyStorage; ephemeral: boolean }> {
	if (process.env.LH_KEYSTORE_URL) {
		const android = AndroidKeyStorage.fromEnv(process.env, PATHS.local);
		if ((await android.status()).available) return { storage: android, ephemeral: false };
	}
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

/** A first start that would have to move local files aside needs the learner's answer first (see `bootstrap`). */
export class JoinChoiceRequiredError extends Error {
	readonly code = "join_choice_required";
	constructor() {
		super("This device has local data and the vault already holds records. Ask the learner to use the vault or cancel.");
		this.name = "JoinChoiceRequiredError";
	}
}

/** What a first start on this device would do, without changing anything (routes.ts `StartPlan`). */
async function planStart(vault: Vault): Promise<{ firstStart: boolean; localFiles: number; vaultHasRecords: boolean }> {
	if (readBootstrap()?.accountId === vault.accountId) return { firstStart: false, localFiles: 0, vaultHasRecords: false };
	const host = new LearnHarnessHost({ dataDir: PATHS.data, localDir: PATHS.local, emit: () => undefined });
	const localFiles = (await host.listAllFiles()).length;
	return { firstStart: true, localFiles, vaultHasRecords: localFiles > 0 ? !(await vaultIsEmpty(vault)) : false };
}

/**
 * The first start on this device with this account (ADR 0007 "Joining with existing local data"):
 * a vault without records is seeded with the data folder; a vault that has records replaces what
 * this folder holds, which moves aside to <local>/pre-vault-<date>/ first and is never deleted.
 * That second case needs the learner's answer ("Use the vault", `choice`), asked by the join screen
 * before the sync starts (routes.ts `begin` and `joinConfirm`): without it this refuses and moves nothing.
 */
async function bootstrap(wired: WiredVault<Stores>, vault: Vault, choice: JoinChoice | undefined): Promise<void> {
	const done = readBootstrap();
	if (done?.accountId === vault.accountId) return;
	// Outbox and state of another account (or a half-finished first start) must not leak into this one.
	rmSync(join(PATHS.local, "vault"), { recursive: true, force: true });
	await wired.engine.init();
	// Older data first (backup, format upgrade, conflict copies): docs/vault-migration.md. It throws for data of a newer build.
	const device = plainStores.deviceStore.getDevice();
	upgradeDataFolder({ dataDir: PATHS.data, localDir: PATHS.local }, { device });
	let preVaultDir: string | null = null;
	if ((await wired.host.listAllFiles()).length > 0) {
		try {
			await seedFirstDevice({ vault, engine: wired.engine });
		} catch (e) {
			if (!(e instanceof VaultNotEmptyError)) throw e;
			if (choice !== "use-vault" && choice !== "merge") throw new JoinChoiceRequiredError();
			preVaultDir = (await joinWithExistingData({ vault, engine: wired.engine, host: wired.host, deviceId: device.id, choice: "use-vault" })).preVaultDir;
		}
	}
	// Recorded before the merge: a restart after this must not join (and move files aside) a second time.
	mkdirSync(join(PATHS.local, "vault"), { recursive: true });
	writeFileSync(join(PATHS.local, "vault", BOOTSTRAP_FILE), JSON.stringify({ accountId: vault.accountId }));
	if (choice === "merge" && preVaultDir) {
		try {
			await mergeInto(wired, preVaultDir);
		} catch (e) {
			// the moved-aside folder is untouched, so Settings -> Vault can merge it again
			console.error("[vault] merging the moved-aside data failed:", e);
		}
	}
}

/** Folds a moved-aside folder into the live data folder (migration/merge.ts), then syncs. */
async function mergeInto(wired: WiredVault<Stores>, fromDir: string) {
	// Current heads first: documentState must know what the vault deleted, or old copies come back.
	// A failed sync throws, and the moved-aside folder stays as it is for a later try.
	await wired.engine.sync();
	const report = await mergePreVault({
		dataDir: PATHS.data,
		localDir: PATHS.local,
		fromDir,
		deviceId: plainStores.deviceStore.getDevice().id,
		sink: wired.engine,
		changed: (paths) => wired.host.applied(paths.map((path) => ({ path, kind: /^graph\/.*\.jsonl$/.test(path) ? "seg" : "doc", deleted: false }))),
	});
	await wired.engine.sync();
	return report;
}

async function migrationState(): Promise<MigrationStateDto> {
	const paths = { dataDir: PATHS.data, localDir: PATHS.local };
	const journal = readJournal(paths);
	return {
		report: scanDataFolder(paths),
		syncthing: planSwitch(PATHS.data),
		lastUpgrade: journal?.finishedAt ? { at: journal.finishedAt, backupDir: journal.backupDir } : null,
		movedAside: listMovedAside(PATHS.local),
	};
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
		// Android: Credential Manager in the Kotlin shell (LH_PASSKEY_URL); desktop: the Electron ceremony window.
		passkeys: process.env.LH_PASSKEY_URL ? AndroidPasskeys.fromEnv(process.env, serverUrl) : new IpcPasskeys({ serverUrl }),
		sync: {
			plan: (vault) => planStart(vault as unknown as Vault),
			start: (vault, o) =>
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
					await bootstrap(next, vault as unknown as Vault, o?.choice);
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
		migration: {
			report: migrationState,
			setAsideSyncthing: async () => {
				const r = setAsideMarkers({ dataDir: PATHS.data, localDir: PATHS.local });
				return { moved: r.moved.map((m) => m.name), remaining: r.remaining };
			},
			merge: (name) =>
				serialized(async () => {
					if (!wired) throw new Error("the vault is not syncing");
					if (!/^pre-vault-\d{8}(-\d+)?$/.test(name) || !listMovedAside(PATHS.local).some((m) => m.name === name)) throw new Error("no such moved-aside folder");
					return mergeInto(wired, join(PATHS.local, name));
				}),
		},
		documents: () => listHistoryDocuments(PATHS.data),
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

