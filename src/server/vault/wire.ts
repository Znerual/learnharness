// wireVault: what src/server/stores.ts would call when the learner is signed in to the vault
// (#37), and leave(), the way back to plain file-system adapters (#60).

import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { leaveVault, SyncEngine, type KeyStorage, type SyncEngineOptions, type Vault } from "@znerual/learnharness-vault-client";

import { wrapChatStore, wrapGraphStore, wrapJobStore, wrapSettingsStore, wrapSourceOrganizationStore, type AdapterContext, wrapPromptOverrideStore } from "./adapters.ts";
import { LearnHarnessHost, type EmitFn } from "./host.ts";
import type { ChatStore, DeviceStore, GraphStore, JobStore, PromptOverrideStore, SettingsStore, SourceOrganizationStore } from "../../core/ports.ts";
import { assertNotSyncthing } from "./syncthing.ts";

/** The slice of `stores` (src/server/stores.ts) that `wireVault` wraps. Other members pass through. */
export interface LearnHarnessStores {
	chatStore: ChatStore;
	graphStore: GraphStore;
	jobStore: JobStore;
	settingsStore: SettingsStore;
	sourceOrganizationStore: SourceOrganizationStore;
	deviceStore: DeviceStore;
}

export interface WireVaultOptions<S extends LearnHarnessStores> {
	/** The plain file-system stores (`stores` in src/server/stores.ts). */
	stores: S;
	/** PATHS.data */
	dataDir: string;
	/** PATHS.local; defaults to the fork's own default for a custom data folder, `<dataDir>-local`. */
	localDir?: string;
	vault: Vault;
	/** `emit` from src/core/events.ts. */
	emit: EmitFn;
	/** The prompt override store (src/store/prompt-overrides.ts `promptOverrides`), when the composition root has it. */
	promptOverrides?: PromptOverrideStore;
	engine?: Partial<Pick<SyncEngineOptions, "now" | "onStatus">>;
}

export interface WiredVault<S extends LearnHarnessStores> {
	/** The stores to hand out: same members as `stores`, the synced ones wrapped. */
	stores: S;
	/** The prompt override store, wrapped (or undefined when none was passed). */
	promptOverrides: PromptOverrideStore | undefined;
	engine: SyncEngine;
	host: LearnHarnessHost;
	/** Loads the outbox, notes every syncable file again (crash gap of createChat/createJob), starts the engine. */
	start(): Promise<void>;
	/** Notes every syncable file; unchanged documents are skipped by hash when pushed. */
	reconcile(): Promise<number>;
	stop(): void;
	/** Outbox entries not yet pushed: tell the learner before sign-out (#60). */
	pendingCount(): number;
	/** Signs out of the vault locally and returns the plain stores (see `leave`). */
	leave(storage: KeyStorage): Promise<LeaveResult<S>>;
}

export interface LeaveResult<S extends LearnHarnessStores> {
	/** Outbox entries that were never pushed and are now lost to the vault. */
	unpushed: number;
	/** The plain file-system stores: the app keeps working on the folder. */
	stores: S;
	promptOverrides: PromptOverrideStore | undefined;
}

/** The host and engine without the store wrappers (what wireVault builds first; the e2e tests use it directly). */
export function createVaultSync(o: { dataDir: string; localDir?: string; vault: Vault; deviceId: string; emit: EmitFn; engine?: WireVaultOptions<LearnHarnessStores>["engine"] }): { host: LearnHarnessHost; engine: SyncEngine; localDir: string } {
	assertNotSyncthing(o.dataDir);
	const localDir = o.localDir ?? `${o.dataDir}-local`;
	if (o.vault.options.device.lhDeviceId !== o.deviceId) {
		throw new Error(`the vault device (${o.vault.options.device.lhDeviceId}) is not this LearnHarness device (${o.deviceId})`);
	}
	const host = new LearnHarnessHost({ dataDir: o.dataDir, localDir, emit: o.emit });
	const engine = new SyncEngine({ vault: o.vault, host, stateDir: join(localDir, "vault"), deviceId: o.deviceId, ...o.engine });
	return { host, engine, localDir };
}

export function wireVault<S extends LearnHarnessStores>(o: WireVaultOptions<S>): WiredVault<S> {
	const { host, engine, localDir } = createVaultSync({ dataDir: o.dataDir, ...(o.localDir ? { localDir: o.localDir } : {}), vault: o.vault, deviceId: o.stores.deviceStore.getDevice().id, emit: o.emit, ...(o.engine ? { engine: o.engine } : {}) });
	const ctx: AdapterContext = { sink: engine, dataDir: o.dataDir, deviceId: () => o.stores.deviceStore.getDevice().id };
	const wrapped: S = {
		...o.stores,
		chatStore: wrapChatStore(o.stores.chatStore, ctx),
		graphStore: wrapGraphStore(o.stores.graphStore, ctx),
		jobStore: wrapJobStore(o.stores.jobStore, ctx),
		settingsStore: wrapSettingsStore(o.stores.settingsStore, ctx),
		sourceOrganizationStore: wrapSourceOrganizationStore(o.stores.sourceOrganizationStore, ctx),
	};
	const wrappedPrompts = o.promptOverrides ? wrapPromptOverrideStore(o.promptOverrides, ctx) : undefined;
	let started = false;
	return {
		stores: wrapped,
		promptOverrides: wrappedPrompts,
		engine,
		host,
		reconcile: () => engine.seedAll(),
		async start() {
			await engine.init();
			await engine.seedAll();
			engine.start();
			started = true;
		},
		stop() {
			if (started) engine.stop();
			started = false;
		},
		pendingCount: () => engine.status().pendingChanges,
		async leave(storage) {
			if (started) engine.stop();
			started = false;
			const { unpushed } = await leaveLocalVault(localDir, storage);
			return { unpushed, stores: o.stores, promptOverrides: o.promptOverrides };
		},
	};
}

/**
 * Deletes `<local>/vault/` (outbox and sync state) and the secrets, and reports the unpushed
 * outbox entries. The data folder stays a plain LearnHarness data folder. It uses the client's
 * `leaveVault`, which resolves `<root>/local/vault`; a local folder not named `local` (the
 * `<data>-local` default) takes the equivalent steps by hand.
 */
export async function leaveLocalVault(localDir: string, storage: KeyStorage, opts: { dryRun?: boolean } = {}): Promise<{ unpushed: number }> {
	if (basename(localDir) === "local") return leaveVault(dirname(localDir), storage, opts);
	const { readFile } = await import("node:fs/promises");
	let unpushed = 0;
	try {
		unpushed = (await readFile(join(localDir, "vault", "outbox.jsonl"), "utf8")).split("\n").filter((l) => l.trim()).length;
	} catch {
		// no outbox
	}
	if (!opts.dryRun) {
		await rm(join(localDir, "vault"), { recursive: true, force: true });
		await storage.clear();
	}
	return { unpushed };
}
