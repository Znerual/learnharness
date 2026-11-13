import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, beforeEach, it } from "node:test";
import { BUILTIN_THEMES, DEFAULT_THEME, resolveActiveTheme, effectiveColors, resolveTheme, sanitizeThemeFile, THEME_COLOR_KEYS } from "../src/core/themes.ts";

const require = createRequire(import.meta.url);
const { PRESET_APPEARANCE, COLOR_KEYS, normalizeAppearance, themeSourceFor, systemVariant, serverDataDir, serverLocalDir, readAppearance, chromeColors } = require("../electron/appearance-chrome.cjs");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-appearance-chrome-"));
after(() => fs.rmSync(data, { recursive: true, force: true }));
beforeEach(() => { fs.rmSync(data, { recursive: true, force: true }); fs.mkdirSync(path.join(data, "themes"), { recursive: true }); });
const record = (appearance: unknown) => fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ version: 1, appearance }));

it("native boot projection stays identical to every core preset and its color vocabulary", () => {
	assert.deepEqual(Object.keys(PRESET_APPEARANCE).sort(), BUILTIN_THEMES.map(t => t.id).sort());
	assert.deepEqual([...COLOR_KEYS].sort(), [...THEME_COLOR_KEYS].sort());
	for (const theme of BUILTIN_THEMES) {
		assert.deepEqual(PRESET_APPEARANCE[theme.id], { mode: theme.mode, background: theme.colors.background });
		for (const background of [undefined, "#101010", "#fff"]) {
			record({ theme: theme.id, background });
			assert.deepEqual(readAppearance(data), { mode: theme.mode, background: effectiveColors(theme, { background }).background });
		}
	}
});

/** The window-facing part (System adds `system` and `variants`). */
const shown = (a: { mode: string; background: string | null }) => ({ mode: a.mode, background: a.background });

it("selected custom files resolve before a renderer; missing or malformed files match core fallback", () => {
	const custom = { ...BUILTIN_THEMES.find(t => t.id === "rose-pine-dawn")!, name: "Custom Paper" };
	for (const raw of [custom, { ...custom, colors: { ...custom.colors, error: "bad" } }, { ...custom, mode: "system" }, { ...custom, name: "!!!" }, null]) {
		fs.writeFileSync(path.join(data, "themes", "custom-paper.json"), JSON.stringify(raw));
		record({ theme: "custom-paper" });
		const parsed = sanitizeThemeFile(raw);
		const resolved = resolveTheme("custom-paper", parsed ? [{ ...parsed, id: "custom-paper", builtin: false }] : []);
		assert.deepEqual(shown(readAppearance(data)), { mode: resolved.mode, background: resolved.colors.background });
	}
	fs.unlinkSync(path.join(data, "themes", "custom-paper.json"));
	record({ theme: "custom-paper", background: "#abc" });
	assert.deepEqual(shown(readAppearance(data)), { mode: "dark", background: "#abc" });
	for (const theme of ["../outside", "__proto__", "constructor", "unknown"]) {
		record({ theme });
		assert.deepEqual(shown(readAppearance(data)), { mode: "dark", background: DEFAULT_THEME.colors.background });
	}
});

it("absent and corrupt records fall back; renderer reports are normalized", () => {
	assert.deepEqual(shown(readAppearance(data)), { mode: "dark", background: "#141414" });
	fs.writeFileSync(path.join(data, "settings.json"), "{");
	assert.deepEqual(shown(readAppearance(data)), { mode: "dark", background: "#141414" });
	for (const theme of [null, [], {}, { toString: null }, 123, true]) {
		record({ theme });
		assert.deepEqual(shown(readAppearance(data)), { mode: "dark", background: "#141414" });
	}
	assert.deepEqual(normalizeAppearance({ mode: "light", background: "#fff" }), { mode: "light", background: "#fff" });
	assert.deepEqual(normalizeAppearance({ mode: "system", background: "white" }), { mode: "dark", background: null });
});

it("native glyphs contrast against final paint, not the theme's mode label", () => {
	for (const mode of ["dark", "light"]) {
		assert.deepEqual(chromeColors({ mode, background: "#101010" }), { color: "#101010", symbolColor: "#e5e5e5" });
		assert.deepEqual(chromeColors({ mode, background: "#fff" }), { color: "#fff", symbolColor: "#1a1a1a" });
	}
	assert.equal(themeSourceFor("dark"), "system", "retain main's OS-following native menus/dialogs");
	assert.equal(themeSourceFor("light"), "light");
});

it("external desktop development reads the server's directory rather than the shell's -dev profile", () => {
	const base = { packagedDataDir: "/fixture/packaged/data", repoRoot: "/fixture/repo", env: {} };
	assert.equal(serverDataDir(base), base.packagedDataDir);
	assert.equal(serverDataDir({ ...base, devUrl: "http://127.0.0.1:9000" }), "/fixture/repo/data");
	assert.equal(serverDataDir({ ...base, devUrl: "http://127.0.0.1:9000", env: { LH_DATA_DIR: data } }), data);
});

it("System resolves per the OS scheme, with both variants for later flips; the source stays system", () => {
	const light = BUILTIN_THEMES.find(t => t.id === "light")!;
	for (const appearance of [undefined, { theme: "system" }, { mode: "system" }]) {
		record(appearance);
		const dark = readAppearance(data, true);
		const day = readAppearance(data, false);
		assert.deepEqual(shown(dark), { mode: "dark", background: "#141414" });
		assert.deepEqual(shown(day), { mode: "light", background: light.colors.background });
		assert.equal(day.system, true);
		assert.deepEqual(day.variants, { light: { mode: "light", background: "#fafafa" }, dark: { mode: "dark", background: "#141414" } });
		assert.equal(themeSourceFor(day.mode, day.system), "system", "a light system pick must not pin the renderer to light");
		assert.deepEqual(shown(systemVariant(day, true)), shown(dark));
	}
	// A custom pair and a background override; a gone custom slot falls back to its factory theme.
	fs.writeFileSync(path.join(data, "themes", "my-paper.json"), JSON.stringify({ ...BUILTIN_THEMES.find(t => t.id === "ivory")!, name: "My Paper" }));
	record({ theme: "system", systemThemes: { light: "my-paper", dark: "gone-theme" }, background: "#abc" });
	assert.deepEqual(readAppearance(data, false).variants, { light: { mode: "light", background: "#abc" }, dark: { mode: "dark", background: "#abc" } });
	record({ theme: "system", systemThemes: { light: "gone-theme" } });
	assert.deepEqual(shown(readAppearance(data, false)), { mode: "light", background: "#fafafa" });
	// An explicit theme ignores the OS; the fork's legacy mode migrates like core's sanitizer.
	record({ theme: "catppuccin-mocha" });
	assert.equal(readAppearance(data, false).system, undefined);
	assert.deepEqual(shown(readAppearance(data, false)), { mode: "dark", background: "#1e1e2e" });
	record({ mode: "light" });
	assert.deepEqual(shown(readAppearance(data, true)), { mode: "light", background: "#fafafa" });
	record({ mode: "dark" });
	assert.deepEqual(shown(readAppearance(data, false)), { mode: "dark", background: "#141414" });
});

it("native boot resolution equals core's resolveActiveTheme", () => {
	for (const id of [undefined, "system", "light", "default", "ivory"]) {
		for (const osDark of [true, false]) {
			record({ theme: id });
			const core = resolveActiveTheme(id, [], undefined, osDark);
			assert.deepEqual(shown(readAppearance(data, osDark)), { mode: core.mode, background: core.colors.background }, `${id} ${osDark}`);
		}
	}
});

it("the renderer's System report keeps both variants; plain reports stay plain", () => {
	const variants = { light: { mode: "light", background: "#fafafa" }, dark: { mode: "dark", background: "#141414" } };
	assert.deepEqual(normalizeAppearance({ mode: "light", background: "#fafafa", system: true, variants }), { mode: "light", background: "#fafafa", system: true, variants });
	assert.deepEqual(normalizeAppearance({ mode: "light", background: "#fafafa", system: true, variants: 3 }), { mode: "light", background: "#fafafa" });
	assert.deepEqual(normalizeAppearance({ mode: "light", background: "#fafafa", variants }), { mode: "light", background: "#fafafa" });
});

it("settings and imported themes come from the device-local folder, the data folder as the legacy fallback", () => {
	const base = { packagedLocalDir: "/fixture/packaged/local", repoRoot: "/fixture/repo", env: {} };
	assert.equal(serverLocalDir(base), base.packagedLocalDir);
	const dev = { ...base, devUrl: "http://127.0.0.1:9000" };
	assert.equal(serverLocalDir(dev), "/fixture/repo/local");
	assert.equal(serverLocalDir({ ...dev, env: { LH_DATA_DIR: data } }), `${data}-local`);
	assert.equal(serverLocalDir({ ...dev, env: { LH_DATA_DIR: data, LH_LOCAL_DIR: "/x/local" } }), "/x/local");

	const local = fs.mkdtempSync(path.join(os.tmpdir(), "lh-appearance-local-"));
	try {
		fs.mkdirSync(path.join(local, "themes"), { recursive: true });
		const paper = { ...BUILTIN_THEMES.find(t => t.id === "ivory")!, name: "My Paper" };
		fs.writeFileSync(path.join(local, "themes", "my-paper.json"), JSON.stringify(paper));
		// Settings only in the local folder; the data folder holds a stale legacy copy.
		fs.writeFileSync(path.join(local, "settings.json"), JSON.stringify({ version: 1, appearance: { theme: "my-paper" } }));
		record({ theme: "catppuccin-mocha" });
		assert.deepEqual(shown(readAppearance([local, data])), { mode: "light", background: paper.colors.background });
		// Not yet migrated: only the data folder has settings and the theme.
		fs.rmSync(path.join(local, "settings.json"));
		fs.rmSync(path.join(local, "themes", "my-paper.json"));
		fs.writeFileSync(path.join(data, "themes", "my-paper.json"), JSON.stringify(paper));
		record({ theme: "my-paper" });
		assert.deepEqual(shown(readAppearance([local, data])), { mode: "light", background: paper.colors.background });
	} finally {
		fs.rmSync(local, { recursive: true, force: true });
	}
});
