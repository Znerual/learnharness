"use strict";
/** Native appearance must be ready before creating a window, independently
 * of the renderer's first report. Keep the small preset boot projection
 * pinned to core's full catalog in appearance-chrome.test.ts. */
const fs = require("node:fs");
const path = require("node:path");

const PRESET_APPEARANCE = {
	default: { mode: "dark", background: "#141414" },
	light: { mode: "light", background: "#fafafa" },
	"catppuccin-latte": { mode: "light", background: "#eff1f5" },
	"catppuccin-frappe": { mode: "dark", background: "#303446" },
	"catppuccin-macchiato": { mode: "dark", background: "#24273a" },
	"catppuccin-mocha": { mode: "dark", background: "#1e1e2e" },
	"rose-pine": { mode: "dark", background: "#191724" },
	"rose-pine-dawn": { mode: "light", background: "#faf4ed" },
	"gruvbox-dark": { mode: "dark", background: "#282828" },
	ivory: { mode: "light", background: "#faf9f5" },
	pastel: { mode: "light", background: "#f2f0e8" },
	"nvchad-onedark": { mode: "dark", background: "#1e222a" },
};
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const COLOR_KEYS = ["background", "surface", "border", "text", "textMuted", "accent", "bold", "italic", "code", "error", "success", "warning"];

function normalizeBasic(a) {
	return {
		mode: a?.mode === "light" ? "light" : "dark",
		background: typeof a?.background === "string" && HEX.test(a.background) ? a.background : null,
	};
}

/** The renderer's report. Under the System theme it also carries
 * `system: true` and both variants, so the shell can follow the OS on its
 * own (nativeTheme "updated") without waiting for the renderer. */
function normalizeAppearance(a) {
	const out = normalizeBasic(a);
	if (a?.system === true && a.variants && typeof a.variants === "object") {
		return { ...out, system: true, variants: { light: normalizeBasic(a.variants.light), dark: normalizeBasic(a.variants.dark) } };
	}
	return out;
}

/** Preserve Electron's pre-theme OS-following menus/dialogs for dark.
 * The app/window palette itself remains pinned to the selected theme.
 * Under the System theme the source is always "system": forcing "light"
 * would pin prefers-color-scheme and the OS could never flip the app. */
function themeSourceFor(mode, system = false) {
	return system || mode !== "light" ? "system" : "light";
}

/** The variant System shows for the OS's current scheme. */
function systemVariant(appearance, osDark) {
	const v = appearance.variants?.[osDark ? "dark" : "light"];
	return v ? { ...appearance, ...v } : appearance;
}

/** Mirror the server's data path in external-dev mode, not the shell's
 * separate -dev userData. Packaged uses the path given to its child. */
function serverDataDir({ devUrl, env, packagedDataDir, repoRoot }) {
	if (!devUrl) return packagedDataDir;
	return env.LH_DATA_DIR ? path.resolve(env.LH_DATA_DIR) : path.join(repoRoot, "data");
}

/** The first readable JSON file among the folders (device-local first, the
 * data folder as the pre-migration fallback); throws when none parses. */
function firstJson(dirs, rel) {
	let error;
	for (const dir of dirs) {
		try { return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")); } catch (e) { error = e; }
	}
	throw error;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One theme id's { mode, background } as core resolves it: a preset, an
 * imported file, or `fallbackId`'s preset when the id is unknown. */
function themeAppearance(dirs, id, fallbackId = "default") {
	let theme = Object.hasOwn(PRESET_APPEARANCE, id) ? PRESET_APPEARANCE[id] : PRESET_APPEARANCE[fallbackId];
	if (typeof id === "string" && id.length <= 64 && SLUG.test(id) && !Object.hasOwn(PRESET_APPEARANCE, id)) {
		try {
			const custom = firstJson(dirs, path.join("themes", `${id}.json`));
			// Match the data-only core parser: malformed files render Default,
			// including files with a valid background but an invalid other ink.
			if (typeof custom?.name === "string" && custom.name.trim() && /[a-z0-9]/i.test(custom.name.normalize("NFD")) &&
				(custom.mode === "dark" || custom.mode === "light") && custom.colors && !Array.isArray(custom.colors) &&
				COLOR_KEYS.every(key => typeof custom.colors[key] === "string" && HEX.test(custom.colors[key]))) {
				theme = { mode: custom.mode, background: custom.colors.background };
			}
		} catch { /* missing/invalid selected file = fallback */ }
	}
	return theme;
}

/** The appearance the window opens in. Mirrors core's record handling: a
 * valid theme id wins; otherwise the fork's legacy `mode` migrates (light
 * -> Light, dark -> Default); otherwise (and for "system") System, which
 * picks the pair's slot by `osDark` (nativeTheme.shouldUseDarkColors). */
/** The device-local folder the server resolves (config.ts LOCAL_ROOT):
 * settings and imported themes live there (multi-device, ADR 0002). The
 * packaged shell gives it to the server as LH_LOCAL_DIR; external
 * development mirrors the server's own fallback. */
function serverLocalDir({ devUrl, env, packagedLocalDir, repoRoot }) {
	if (!devUrl) return packagedLocalDir;
	if (env.LH_LOCAL_DIR) return path.resolve(env.LH_LOCAL_DIR);
	if (env.LH_DATA_DIR) return `${path.resolve(env.LH_DATA_DIR)}-local`;
	return path.join(repoRoot, "local");
}

function readAppearance(folders, osDark = true) {
	const dirs = Array.isArray(folders) ? folders : [folders];
	let a;
	try { a = firstJson(dirs, "settings.json")?.appearance; }
	catch { /* absent/corrupt record = factory */ }
	let id = typeof a?.theme === "string" && a.theme.length <= 64 && SLUG.test(a.theme) ? a.theme : undefined;
	if (id === undefined) id = a?.mode === "light" ? "light" : a?.mode === "dark" ? "default" : "system";
	const override = normalizeBasic(a).background;
	if (id !== "system") {
		const theme = themeAppearance(dirs, id);
		return { mode: theme.mode, background: override ?? theme.background };
	}
	const slotTheme = slot => {
		const wanted = typeof a?.systemThemes?.[slot] === "string" ? a.systemThemes[slot] : undefined;
		const t = themeAppearance(dirs, wanted ?? (slot === "dark" ? "default" : "light"), slot === "dark" ? "default" : "light");
		return { mode: t.mode, background: override ?? t.background };
	};
	const variants = { light: slotTheme("light"), dark: slotTheme("dark") };
	return { ...variants[osDark ? "dark" : "light"], system: true, variants };
}

function luminance(hex) {
	const full = hex.length === 4 ? hex.slice(1).split("").map(c => c + c).join("") : hex.slice(1);
	return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
		const c = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
		return sum + weight * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	}, 0);
}

/** Title-bar glyph contrast follows the actual final background, including
 * overrides that do not match the selected theme's dark/light label. */
function chromeColors(appearance) {
	const color = appearance.background ?? (appearance.mode === "light" ? "#f5f5f3" : "#141414");
	const bg = luminance(color);
	const contrast = ink => (Math.max(bg, luminance(ink)) + 0.05) / (Math.min(bg, luminance(ink)) + 0.05);
	return { color, symbolColor: contrast("#e5e5e5") > contrast("#1a1a1a") ? "#e5e5e5" : "#1a1a1a" };
}

module.exports = { PRESET_APPEARANCE, COLOR_KEYS, normalizeAppearance, themeSourceFor, systemVariant, serverDataDir, serverLocalDir, readAppearance, chromeColors };
