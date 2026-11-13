"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/** Inside the LearnHarness Android app (multi-device, step 3)? The root
 *  layout decides once from the request's user agent (core/android-shell.ts)
 *  and also marks <html> with .lh-android, which the `android:` CSS variant
 *  keys on. Behaviour that CSS cannot express reads this hook. */
const AndroidShellContext = createContext(false);

/**
 * THE BACK STACK (owner, 2026-10-30): Android's back button closes what is
 * open on top — the drawer, a dialog, an overlay, the node sheet — before
 * the page navigates back. Open layers register here; the app's shell asks
 * window.lhAndroidBack() first and navigates only when it answers false.
 *
 * Two systems feed it, and the NEWEST layer of either wins: layers that
 * register with useAndroidBack, and a "back source" such as the interaction
 * layers (popovers, host dialogs, plugin layers, editor scopes —
 * components/interaction-layers.tsx), which closes through its own dismiss
 * path. Every entry carries a number from one shared counter (taken when it
 * opens), so one press closes exactly one layer.
 */
let backSequence = 0;
export const nextBackSequence = (): number => ++backSequence;

/** A closable layer; `close` answers false when it cannot close (the next newest is tried). */
export interface BackCandidate { seq: number; close: () => boolean }
const backStack: BackCandidate[] = [];
const backSources = new Set<() => BackCandidate | null>();

/** Register a second layer system (its newest closable layer, or null). Returns the unregister. */
export function registerAndroidBackSource(newest: () => BackCandidate | null): () => void {
	backSources.add(newest);
	return () => { backSources.delete(newest); };
}

/** The back press: close the single newest layer across all systems. False = nothing handled it. */
export function handleAndroidBack(): boolean {
	const candidates = [...backStack];
	for (const source of backSources) {
		const candidate = source();
		if (candidate) candidates.push(candidate);
	}
	candidates.sort((x, y) => y.seq - x.seq);
	for (const candidate of candidates) if (candidate.close()) return true;
	return false;
}

export function AndroidShellProvider({ android, children }: { android: boolean; children: React.ReactNode }) {
	useEffect(() => {
		if (!android) return;
		const w = window as typeof window & { lhAndroidBack?: () => boolean };
		w.lhAndroidBack = handleAndroidBack;
		return () => {
			delete w.lhAndroidBack;
		};
	}, [android]);
	return <AndroidShellContext.Provider value={android}>{children}</AndroidShellContext.Provider>;
}

export function useAndroidShell(): boolean {
	return useContext(AndroidShellContext);
}

/** While `open`, Android's back button calls `close` (the newest open layer first). */
export function useAndroidBack(open: boolean, close: () => void): void {
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		if (!open) return;
		const entry: BackCandidate = { seq: nextBackSequence(), close: () => { closeRef.current(); return true; } };
		backStack.push(entry);
		return () => {
			const i = backStack.indexOf(entry);
			if (i >= 0) backStack.splice(i, 1);
		};
	}, [open]);
}
