/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { createGraphLedgerStore } from "../store/graph.ts";
import { effectiveGraphStore } from "../core/graph-ledgers.ts";
import { sourceOrganizationStore } from "../store/source-organization.ts";
import { createJobStore } from "../store/jobs.ts";
import { migratePromptSwitches, settingsStore as plainSettingsStore, writeSettings as writePlainSettings } from "../store/settings.ts";
import { promptOverrides as plainPromptOverrides } from "../store/prompt-overrides.ts";
import type { PromptOverrideStore } from "../core/ports.ts";
import type { UserSettings } from "../core/settings.ts";
import { activeVaultStores, type VaultStores } from "./vault/active.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { migrateCustomEndpoints } from "./custom-provider-migration.ts";
import { migrateDeviceLocalData } from "../store/local-migration.ts";
import { deviceStore } from "../store/device.ts";

// Multi-device (ADR 0002): device-local records leave the synced data
// folder before any store reads them — once per process, idempotent.
migrateDeviceLocalData();
migratePromptSwitches();
// Custom endpoints (custom-endpoints wave): the legacy sections become
// customProviders entries before anything resolves a model.
migrateCustomEndpoints();

/** The plain file-system adapters. The graph store is this device's raw
 *  ledger adapter behind the derived effective view (multi-device, ADR 0003). */
const plain = {
	chatStore,
	graphStore: effectiveGraphStore(createGraphLedgerStore(() => deviceStore.getDevice().id)),
	sourceOrganizationStore,
	jobStore: createJobStore(() => deviceStore.getDevice()),
	settingsStore: plainSettingsStore,
	deviceStore,
};

/** The synced member `key` of the vault-wrapped stores while the learner is signed in to
 *  the vault (src/server/vault/service.ts), else the plain adapter. Read per access. */
function current<K extends Exclude<keyof VaultStores, "promptOverrides">>(key: K): (typeof plain)[K] {
	return (activeVaultStores()?.[key] as (typeof plain)[K] | undefined) ?? plain[key];
}

/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally.
 *  Signed out of the vault (the default, and every build without the vault package) each member
 *  is the plain adapter above. While signed in, the members that sync resolve to the wrapped
 *  stores of the vault, so nobody holds a plain store across a sign-in: always go through
 *  `stores.x` at call time, never keep `stores.x` or destructure it at import. */
export const stores: Stores = {
	get chatStore() {
		return current("chatStore");
	},
	get graphStore() {
		return current("graphStore");
	},
	get sourceOrganizationStore() {
		return current("sourceOrganizationStore");
	},
	get jobStore() {
		return current("jobStore");
	},
	get settingsStore() {
		return current("settingsStore");
	},
	deviceStore: plain.deviceStore,
};

/** The un-wrapped adapters, for the vault service to wrap. Nothing else uses these. */
export const plainStores: Stores = plain;

export type Stores = {
	chatStore: typeof chatStore;
	graphStore: ReturnType<typeof effectiveGraphStore>;
	sourceOrganizationStore: typeof sourceOrganizationStore;
	jobStore: ReturnType<typeof createJobStore>;
	settingsStore: typeof plainSettingsStore;
	deviceStore: typeof deviceStore;
};

/** The settings record writer behind the settings routes: `writeSettings` of the settings store,
 *  through the vault wrapper while signed in (the prompt switches sync). */
export function writeSettingsRecord(raw: unknown): UserSettings {
	if (!activeVaultStores()) return writePlainSettings(raw);
	return (stores.settingsStore.writeSettings as unknown as (raw: unknown) => UserSettings)(raw);
}

/** The prompt override store behind the prompt routes, through the vault wrapper while signed in. */
export const promptOverrides: PromptOverrideStore = {
	listOverrides: () => plainPromptOverrides.listOverrides(),
	readOverride: (segmentPath) => plainPromptOverrides.readOverride(segmentPath),
	writeOverride: (segmentPath, text) => (activeVaultStores()?.promptOverrides ?? plainPromptOverrides).writeOverride(segmentPath, text),
	deleteOverride: (segmentPath) => (activeVaultStores()?.promptOverrides ?? plainPromptOverrides).deleteOverride(segmentPath),
};

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(plainSettingsStore.readSettings());
}

// Boot: register the custom endpoints (when configured) into piModels(); the
// /api/custom-providers routes re-sync after every change.
syncCustomProvider();
