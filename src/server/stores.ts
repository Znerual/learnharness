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
import { migratePromptSwitches, settingsStore } from "../store/settings.ts";
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

/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally.
 *  The graph store is this device's raw ledger adapter behind the derived
 *  effective view (multi-device, ADR 0003). */
export const stores = {
	chatStore,
	graphStore: effectiveGraphStore(createGraphLedgerStore(() => deviceStore.getDevice().id)),
	sourceOrganizationStore,
	jobStore: createJobStore(() => deviceStore.getDevice()),
	settingsStore,
	deviceStore,
};

export type Stores = typeof stores;

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

// Boot: register the custom endpoints (when configured) into piModels(); the
// /api/custom-providers routes re-sync after every change.
syncCustomProvider();
