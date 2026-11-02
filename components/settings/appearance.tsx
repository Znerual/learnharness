"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The MODE is the one
 * class swap (light mode wave, 2026-11-02): globals.css carries the light
 * palette on :root and the dark palette on .dark; this provider toggles
 * `dark` on <html>. The first paint is already right — app/layout.tsx runs
 * themeScript before the page paints — so the provider only follows
 * changes: the setting, and the OS flipping while the mode is "system".
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FACTORY_SETTINGS, type AppearanceMode, type AppearanceSettings } from "@/src/core";
import { DARK_QUERY, MODE_BACKGROUNDS, resolveMode, type ResolvedMode } from "./theme-mode";

export type { ResolvedMode } from "./theme-mode";

/** One MediaQueryList for the page's life (browser only). */
let darkQuery: MediaQueryList | null = null;
function osDarkQuery(): MediaQueryList {
	darkQuery ??= window.matchMedia(DARK_QUERY);
	return darkQuery;
}

function subscribeOsMode(onChange: () => void): () => void {
	const query = osDarkQuery();
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

const osPrefersDarkNow = () => osDarkQuery().matches;

/** Whether the OS prefers dark right now; re-renders when it flips. The
 *  hydration snapshot is the LIVE value too, not the server's false: with
 *  false, the first client commit would resolve "system" to light and strip
 *  the `dark` class the pre-paint script just set — the flash themeScript
 *  exists to prevent. Nothing in the server markup depends on this value
 *  (its readers run in effects or in the client-opened settings dialog). */
function useOsPrefersDark(): boolean {
	return useSyncExternalStore(
		subscribeOsMode,
		osPrefersDarkNow,
		() => (typeof window === "undefined" ? false : osPrefersDarkNow()),
	);
}

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** One channel moved along the mode's curve, clamped to 0–255: offsets
 *  matching the hand-picked palettes (dark #141414 → card #1c1c1c (+8) →
 *  accent #2a2a2a (+22) → border #434343 (+47); light mirrors them, #fafafa
 *  → #f2f2f2 (-8) → #e4e4e4 (-22) → #cbcbcb (-47)) — the "per-mode
 *  derivation in code" the schema promises, as the thinnest curve that
 *  keeps the palette's relationships. */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.max(0, Math.min(255, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** The derived palette a chosen background implies, on the active mode's
 *  curve (owner, light mode wave: one shared background, curve by mode —
 *  dark lightens the surfaces, light darkens them): background itself, the
 *  raised surfaces (card/popover/secondary/muted, ±8), the accent (±22),
 *  the edges (border/input, ±47), and primary-foreground (the inverted text
 *  on primary = the background's own color, as today). */
export function derivedPalette(background: string, mode: ResolvedMode = "dark"): Record<string, string> {
	const sign = mode === "dark" ? 1 : -1;
	const card = raise(background, sign * 8);
	const accent = raise(background, sign * 22);
	const border = raise(background, sign * 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	mode: ResolvedMode = "dark",
): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null) Object.assign(vars, derivedPalette(a.background, mode));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The palette showing now ("system" resolved against the OS). */
	resolvedMode: ResolvedMode;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	resolvedMode: "dark",
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	initialMode,
	children,
}: {
	/** The mode the server read from the settings record (app/layout.tsx) —
	 *  holds until this provider's own fetch arrives, so the class never
	 *  flips to the factory mode in between. */
	initialMode: AppearanceMode;
	children: React.ReactNode;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const [loaded, setLoaded] = useState(false);
	const appliedRef = useRef<string>("");
	const osPrefersDark = useOsPrefersDark();
	const mode = loaded ? resolveAppearance(delta).mode : initialMode;
	const resolvedMode = resolveMode(mode, osPrefersDark);

	// The mode is the one class swap; the Electron shell repaints its title
	// bar and window background to match (electron/main.cjs, lh:theme). A
	// LAYOUT effect: it lands before any child's passive effect, so readers
	// of computed tokens (the graph canvas) already see the new mode.
	const shownBackground = resolveAppearance(delta).background ?? MODE_BACKGROUNDS[resolvedMode];
	useLayoutEffect(() => {
		document.documentElement.classList.toggle("dark", resolvedMode === "dark");
		window.lh?.setTheme?.(resolvedMode, shownBackground);
	}, [resolvedMode, shownBackground]);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta), resolvedMode), [delta, resolvedMode]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
				setLoaded(true);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
		setLoaded(true);
	}, []);

	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), resolvedMode, onAppearanceChange }),
		[delta, resolvedMode, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}