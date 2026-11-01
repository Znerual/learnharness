// Syncthing guard and migration plan (#41, #61; ADR 0001 and ADR 0007 "Moving from Syncthing").

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** What Syncthing leaves in a folder it shares. */
export const SYNCTHING_MARKERS = [".stfolder", ".stignore", ".stversions"] as const;

export interface SyncthingMarker {
	/** The marker's name, e.g. `.stfolder`. */
	name: string;
	/** Absolute path of the marker. */
	path: string;
	/** The folder that holds it: the data folder itself, or an ancestor that Syncthing shares as a whole. */
	folder: string;
}

/**
 * Markers in the data folder and in every ancestor of it. An ancestor counts because Syncthing
 * shares the whole tree below a folder that carries `.stfolder`.
 */
export function findSyncthingMarkers(dataDir: string): SyncthingMarker[] {
	const out: SyncthingMarker[] = [];
	let dir = resolve(dataDir);
	for (;;) {
		for (const name of SYNCTHING_MARKERS) {
			const path = join(/*turbopackIgnore: true*/ dir, name);
			if (existsSync(/*turbopackIgnore: true*/ path)) out.push({ name, path, folder: dir });
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

export const SYNCTHING_REFUSAL =
	"The vault does not run on a data folder that Syncthing shares (ADR 0001). A learner who signs in to the vault does not use Syncthing for that data folder. " +
	"Stop Syncthing for this folder on every device and remove .stfolder (also .stignore and .stversions), then try again.";

export class SyncthingFolderError extends Error {
	readonly code = "syncthing_folder";
	constructor(readonly markers: SyncthingMarker[]) {
		super(`${SYNCTHING_REFUSAL} Found: ${markers.map((m) => m.path).join(", ")}.`);
		this.name = "SyncthingFolderError";
	}
}

/** Refuses the vault while the data folder carries Syncthing markers (ADR 0001). */
export function assertNotSyncthing(dataDir: string): void {
	const markers = findSyncthingMarkers(dataDir);
	if (markers.length > 0) throw new SyncthingFolderError(markers);
}

export interface MigrationStep {
	/** Which devices do this step. */
	on: "every device" | "device with the most complete data" | "every other device";
	text: string;
}

export interface SyncthingMigrationPlan {
	/** True when the data folder carries Syncthing markers. */
	needed: boolean;
	markers: SyncthingMarker[];
	steps: MigrationStep[];
}

/** The user-facing steps of ADR 0007 "Moving from Syncthing", in order. MIGRATION.md repeats them. */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
	{ on: "every device", text: "Stop Syncthing for the LearnHarness data folder and remove its .stfolder (also .stignore and .stversions). Do not add the folder back to Syncthing later." },
	{ on: "device with the most complete data", text: "Sign up for the vault. This device seeds the vault with its whole data folder." },
	{ on: "every other device", text: 'Sign in to the vault and choose "Use the vault". Your local session, job, prompt and graph files move to local/pre-vault-<date>/, and the vault\'s versions are downloaded. Your own graph files stay and are uploaded.' },
];

/** Detects Syncthing markers and returns the migration steps (the app shows them when it finds `.stfolder`). */
export function planSyncthingMigration(dataDir: string): SyncthingMigrationPlan {
	const markers = findSyncthingMarkers(dataDir);
	return { needed: markers.length > 0, markers, steps: markers.length > 0 ? [...MIGRATION_STEPS] : [] };
}
