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
import { createJobStore } from "../store/jobs.ts";
import { migratePromptSwitches, settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { setCustomEndpointSource } from "../agent/models.ts";
import { migrateDeviceLocalData } from "../store/local-migration.ts";
import { deviceStore } from "../store/device.ts";

// Multi-device (ADR 0002): device-local records leave the synced data
// folder before any store reads them — once per process, idempotent.
migrateDeviceLocalData();
migratePromptSwitches();

/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally.
 *  The graph store is this device's raw ledger adapter behind the derived
 *  effective view (multi-device, ADR 0003). */
export const stores = {
	chatStore,
	graphStore: effectiveGraphStore(createGraphLedgerStore(() => deviceStore.getDevice().id)),
	jobStore: createJobStore(() => deviceStore.getDevice()),
	settingsStore,
	deviceStore,
};

export type Stores = typeof stores;

// Custom endpoints (custom-endpoints wave, 2026-10-24): the engine
// collection re-syncs its custom providers from the settings record on
// every access — wired here, beside the settings adapter, so every path
// that reaches piModels() through the server sees the same record.
setCustomEndpointSource(() => settingsStore.readSettings()?.endpoints?.list ?? []);

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
