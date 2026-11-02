/**
 * The vault-wrapped stores currently in use, if any. No imports from the vault client, so
 * src/server/stores.ts can read it in a build without the vault package.
 *
 * The registry lives on globalThis for the same reason as the event bus (src/core/events.ts):
 * `next dev` compiles every route as its own module entry, so a module-level variable would be a
 * different instance in the vault route and in the routes that read the stores.
 */

import type { ChatStore, GraphStore, JobStore, PromptOverrideStore, SettingsStore, SourceOrganizationStore } from "../../core/ports.ts";

/** The store members the vault wraps; every other member of `stores` is never replaced. */
export interface VaultStores {
	chatStore: ChatStore;
	graphStore: GraphStore;
	jobStore: JobStore;
	settingsStore: SettingsStore;
	sourceOrganizationStore: SourceOrganizationStore;
	promptOverrides?: PromptOverrideStore | undefined;
}

const KEY = Symbol.for("learnharness.vault.activeStores");
type Slot = { [KEY]?: VaultStores | null };

/** The wrapped stores while the learner is signed in and the sync engine runs, else null. */
export function activeVaultStores(): VaultStores | null {
	return (globalThis as Slot)[KEY] ?? null;
}

export function setActiveVaultStores(stores: VaultStores | null): void {
	(globalThis as Slot)[KEY] = stores;
}
