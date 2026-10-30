/**
 * THE DEVICE-LOCAL SPLIT MIGRATION (multi-device, ADR 0002): moves the
 * records that used to live in the data folder but belong to one device —
 * settings.json, graph/positions.json, graph/render-settings.json, debug/ —
 * into the device-local folder. Runs once per server process from the
 * composition root (src/server/stores.ts) before any store reads them.
 *
 * Idempotent and conservative: a legacy file moves only when its
 * device-local twin does not exist yet. When both exist the device-local
 * one is authoritative and the legacy one is left untouched (it may be a
 * stale copy another device's older app synced in).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEGACY_DEVICE_LOCAL, PATHS, POSITIONS_FILE, RENDER_SETTINGS_FILE, SETTINGS_FILE } from "../../config.ts";

const MOVES: ReadonlyArray<readonly [from: string, to: string]> = [
	[LEGACY_DEVICE_LOCAL.settings, SETTINGS_FILE],
	[LEGACY_DEVICE_LOCAL.positions, POSITIONS_FILE],
	[LEGACY_DEVICE_LOCAL.renderSettings, RENDER_SETTINGS_FILE],
	[LEGACY_DEVICE_LOCAL.debug, PATHS.debug],
];

export function migrateDeviceLocalData(): void {
	for (const [from, to] of MOVES) {
		if (!fs.existsSync(from) || fs.existsSync(to)) continue;
		fs.mkdirSync(path.dirname(to), { recursive: true });
		try {
			fs.renameSync(from, to);
		} catch (err) {
			// The two folders may sit on different filesystems (Android: shared
			// storage vs app-private storage) — copy, then remove the source.
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			fs.cpSync(from, to, { recursive: true });
			fs.rmSync(from, { recursive: true, force: true });
		}
	}
}
