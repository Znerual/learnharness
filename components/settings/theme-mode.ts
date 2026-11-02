/**
 * The color mode helpers (light mode wave, 2026-11-02), kept out of the
 * "use client" appearance module: the root layout (a server component)
 * calls themeScript, and a client module's exports cannot run on the server.
 */

import type { AppearanceMode } from "@/src/core";

/** The palette actually showing: a mode setting with "system" resolved. */
export type ResolvedMode = "dark" | "light";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Each mode's default main background (app/globals.css :root / .dark). */
export const MODE_BACKGROUNDS: Record<ResolvedMode, string> = { dark: "#141414", light: "#fafafa" };

/** The mode setting → the palette to show, given whether the OS prefers dark. */
export function resolveMode(mode: AppearanceMode, osPrefersDark: boolean): ResolvedMode {
	if (mode === "system") return osPrefersDark ? "dark" : "light";
	return mode;
}

/** The pre-paint script (app/layout.tsx puts it in <head>): it applies the
 *  mode before the browser paints, so no page ever flashes the wrong
 *  palette. The `dark` class is owned by this script and the provider —
 *  never by React's className prop, which a refresh would rewrite. */
export function themeScript(mode: AppearanceMode): string {
	return `(function(){try{var m=${JSON.stringify(mode)};if(m==="system")m=matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light";if(m==="dark")document.documentElement.classList.add("dark")}catch(e){}})()`;
}

