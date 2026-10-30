"use client";

import { createContext, useContext } from "react";

/** Inside the LearnHarness Android app (multi-device, step 3)? The root
 *  layout decides once from the request's user agent (core/android-shell.ts)
 *  and also marks <html> with .lh-android, which the `android:` CSS variant
 *  keys on. Behaviour that CSS cannot express reads this hook. */
const AndroidShellContext = createContext(false);

export function AndroidShellProvider({ android, children }: { android: boolean; children: React.ReactNode }) {
	return <AndroidShellContext.Provider value={android}>{children}</AndroidShellContext.Provider>;
}

export function useAndroidShell(): boolean {
	return useContext(AndroidShellContext);
}
