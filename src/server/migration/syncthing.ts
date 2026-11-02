/**
 * The guided Syncthing-to-vault switch (docs/vault-migration.md "Syncthing"). The vault refuses a
 * folder that Syncthing shares (ADR 0001), and removing a folder in Syncthing's own screen leaves
 * `.stfolder` (and `.stversions`) behind. `planSwitch` tells the app what to show; `setAsideMarkers`
 * is the one step the app can do for the learner after they confirm they removed the folder from
 * Syncthing on every device. It only RENAMES Syncthing's marker files out of the way: nothing of
 * Syncthing's and nothing of the learner's is deleted, and if Syncthing still shares the folder it
 * stops on its own because its marker is gone.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { SyncthingSwitchPlan } from "../../core/vault/migration.ts";
import { findSyncthingMarkers, SYNCTHING_MARKERS } from "../vault/syncthing.ts";

export const SWITCH_STEPS: readonly string[] = [
	"Close LearnHarness on every device that shares this folder, or leave it idle.",
	"In Syncthing, on every device, remove the LearnHarness folder from the list. Choose Remove, not Delete: your files stay.",
	"Come back here and choose \"I removed it everywhere\". LearnHarness moves Syncthing's marker files out of the way and keeps them.",
	"Create the vault account on the device with the most complete data. It uploads everything. Then sign in on your other devices.",
];

export function planSwitch(dataDir: string): SyncthingSwitchPlan {
	const root = path.resolve(dataDir);
	const markers = findSyncthingMarkers(dataDir).map((m) => ({ name: m.name, folder: m.folder, canSetAside: path.resolve(m.folder) === root }));
	return { needed: markers.length > 0, markers, steps: markers.length > 0 ? [...SWITCH_STEPS] : [] };
}

function stampOf(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export interface SetAsideResult {
	/** Where each marker went. */
	moved: { name: string; to: string }[];
	/** Markers above the data folder: Syncthing shares a whole tree there, so the learner removes them by hand. */
	remaining: string[];
}

/** Renames the markers inside the data folder to the device-local folder (or, across file systems, to a name beside them). */
export function setAsideMarkers(o: { dataDir: string; localDir: string; now?: () => Date }): SetAsideResult {
	const root = path.resolve(o.dataDir);
	const stamp = stampOf((o.now ?? (() => new Date()))());
	const dest = path.join(o.localDir, "migration", `syncthing-${stamp}`);
	const moved: SetAsideResult["moved"] = [];
	for (const name of SYNCTHING_MARKERS) {
		const from = path.join(root, name);
		if (!fs.existsSync(from)) continue;
		let to = path.join(dest, name);
		try {
			fs.mkdirSync(dest, { recursive: true });
			fs.renameSync(from, to);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
			// another file system: the cheap, loss-free move is a rename beside it
			to = `${from}.set-aside-${stamp}`;
			fs.renameSync(from, to);
		}
		moved.push({ name, to });
	}
	const remaining = findSyncthingMarkers(o.dataDir).map((m) => m.path);
	return { moved, remaining };
}
