/**
 * THE FIRST-PAINT THEME (theme wave, 2026-11-04): what app/layout.tsx puts
 * on <html> before any client code runs — the record's appearance, the
 * active theme (a preset or an imported file; Default when the id is gone)
 * and its color variables with every override applied. Read the record
 * and only the selected custom file (the layout calls connection()
 * first, so this never bakes into a prerender).
 *
 * SYSTEM (owner, 2026-11): the server cannot know the OS's color scheme,
 * so for the System theme the boot carries BOTH variants of the pair; the
 * layout renders the dark one as the baseline and a tiny inline script
 * (systemBootScript) swaps in the light one before first paint when
 * prefers-color-scheme says so.
 */

import {
	effectiveColors,
	isBuiltinThemeId,
	resolveActiveTheme,
	SYSTEM_THEME_ID,
	themeVars,
	type AppearanceSettings,
	type Theme,
	type ThemeMode,
} from "../core";
import { themeStore } from "../store/themes.ts";
import { readSettings } from "../store/settings.ts";

/** One resolved variant: the `<html>` class and its color variables. */
export interface BootVariant {
	mode: ThemeMode;
	vars: Record<string, string>;
}

/** Everything the layout needs for a flash-free first paint. */
export interface ThemeBoot {
	appearance: AppearanceSettings | undefined;
	/** The theme rendered by the server: the chosen one, or for System the
	 *  dark slot (the script corrects it for a light OS before paint). */
	theme: Theme;
	/** The CSS variables for <html style>. */
	vars: Record<string, string>;
	/** Imported themes the record names (the provider's catalog seed). */
	customs: Theme[];
	/** System only: both variants, for the pre-paint script. */
	system: { light: BootVariant; dark: BootVariant } | null;
}

/** Read the record and the selected custom file(s); resolve the active theme and its vars. */
export function readThemeBoot(): ThemeBoot {
	const appearance = readSettings()?.appearance;
	const id = appearance?.theme;
	const isSystem = !id || id === SYSTEM_THEME_ID;
	const wanted = isSystem ? [appearance?.systemThemes?.light, appearance?.systemThemes?.dark] : [id];
	const customs: Theme[] = [];
	for (const w of wanted) {
		if (!w || isBuiltinThemeId(w) || customs.some((c) => c.id === w)) continue;
		const custom = themeStore.readTheme(w);
		if (custom) customs.push(custom);
	}
	const variant = (dark: boolean): BootVariant & { theme: Theme } => {
		const theme = resolveActiveTheme(id, customs, appearance?.systemThemes, dark);
		return { theme, mode: theme.mode, vars: themeVars(effectiveColors(theme, appearance), theme.mode) };
	};
	const dark = variant(true);
	if (!isSystem) return { appearance, theme: dark.theme, vars: dark.vars, customs, system: null };
	const light = variant(false);
	return {
		appearance,
		theme: dark.theme,
		vars: dark.vars,
		customs,
		system: { light: { mode: light.mode, vars: light.vars }, dark: { mode: dark.mode, vars: dark.vars } },
	};
}

/** The pre-paint script for the System theme: before the first frame, pick
 *  the variant matching prefers-color-scheme and apply its class and
 *  variables to <html>. Self-contained (it runs before any bundle) and
 *  fail-safe (the server baseline stays on any error). */
export function systemBootScript(system: { light: BootVariant; dark: BootVariant }): string {
	const data = JSON.stringify(system).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	return `(function(){try{var v=${data};var d=matchMedia("(prefers-color-scheme: dark)").matches?v.dark:v.light;var r=document.documentElement;r.classList.remove("dark","light");r.classList.add(d.mode);for(var k in d.vars)r.style.setProperty(k,d.vars[k])}catch(e){}})()`;
}
