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
 */
const backStack: Array<{ close: () => void }> = [];

export function AndroidShellProvider({ android, children }: { android: boolean; children: React.ReactNode }) {
	useEffect(() => {
		if (!android) return;
		const w = window as typeof window & { lhAndroidBack?: () => boolean };
		w.lhAndroidBack = () => {
			const top = backStack.at(-1);
			if (!top) return false;
			top.close();
			return true;
		};
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
		const entry = { close: () => closeRef.current() };
		backStack.push(entry);
		return () => {
			const i = backStack.indexOf(entry);
			if (i >= 0) backStack.splice(i, 1);
		};
	}, [open]);
}
