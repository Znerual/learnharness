/**
 * THE DEVICE-LOCAL SPLIT MIGRATION (multi-device, ADR 0002): moves the
 * records that used to live in the data folder but belong to one device —
 * settings.json, graph/positions.json, graph/render-settings.json, debug/,
 * themes/, plugins/ —
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
import { moveFile } from "./fs-files.ts";
import { LEGACY_DEVICE_LOCAL, PATHS, PLUGINS_DIR, POSITIONS_FILE, RENDER_SETTINGS_FILE, SETTINGS_FILE, THEMES_DIR } from "../../config.ts";

/** The records that moved from the data folder to the device-local folder, as [from, to] pairs. */
export function deviceLocalMoves(dataDir: string, localDir: string): ReadonlyArray<readonly [from: string, to: string]> {
	return [
		[path.join(dataDir, "settings.json"), path.join(localDir, "settings.json")],
		[path.join(dataDir, "graph", "positions.json"), path.join(localDir, "positions.json")],
		[path.join(dataDir, "graph", "render-settings.json"), path.join(localDir, "render-settings.json")],
		[path.join(dataDir, "debug"), path.join(localDir, "debug")],
		[path.join(dataDir, "themes"), path.join(localDir, "themes")],
		[path.join(dataDir, "plugins"), path.join(localDir, "plugins")],
	];
}

const MOVES: ReadonlyArray<readonly [from: string, to: string]> = [
	[LEGACY_DEVICE_LOCAL.settings, SETTINGS_FILE],
	[LEGACY_DEVICE_LOCAL.positions, POSITIONS_FILE],
	[LEGACY_DEVICE_LOCAL.renderSettings, RENDER_SETTINGS_FILE],
	[LEGACY_DEVICE_LOCAL.debug, PATHS.debug],
	[LEGACY_DEVICE_LOCAL.themes, THEMES_DIR],
	[LEGACY_DEVICE_LOCAL.plugins, PLUGINS_DIR],
];

/** The moves that are folders of independent entries (themes, plugins). */
const FOLDER_MOVES: ReadonlySet<string> = new Set([LEGACY_DEVICE_LOCAL.themes, LEGACY_DEVICE_LOCAL.plugins]);

/** A legacy folder whose device-local twin already exists (a theme imported
 *  or a plugin installed since an earlier run) moves entry by entry: what the
 *  twin lacks comes across, what it has stays untouched (never overwritten),
 *  and the legacy folder goes only when every entry has moved. */
function mergeFolder(from: string, to: string): void {
	for (const name of fs.readdirSync(from)) {
		const target = path.join(to, name);
		if (!fs.existsSync(target)) moveFile(path.join(from, name), target);
	}
	if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
}

/** Marks that this device moved its themes/ and plugins/ out of the synced
 *  folder. Executable plugin code must never be pulled in again from a
 *  legacy folder an older device syncs back, so those two move ONCE. */
const FOLDERS_DONE = path.join(PATHS.local, "migrations", "themes-plugins.done");

export function migrateDeviceLocalData(): void {
	const foldersDone = fs.existsSync(FOLDERS_DONE);
	for (const [from, to] of MOVES) {
		if (FOLDER_MOVES.has(from) && foldersDone) continue;
		if (!fs.existsSync(from)) continue;
		if (!fs.existsSync(to)) moveFile(from, to);
		else if (FOLDER_MOVES.has(from) && fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) mergeFolder(from, to);
	}
	if (!foldersDone) {
		fs.mkdirSync(path.dirname(FOLDERS_DONE), { recursive: true });
		fs.writeFileSync(FOLDERS_DONE, `${new Date().toISOString()}\n`);
	}
}
