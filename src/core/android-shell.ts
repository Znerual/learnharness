/**
 * THE ANDROID SHELL MARKER (multi-device, step 3): the LearnHarness Android
 * app's WebView appends "LearnHarnessAndroid/<version>" to its user agent.
 * The phone layout applies only there (owner ruling) — a phone browser or a
 * narrow desktop window keeps the desktop layout. Browser-safe.
 */
export const ANDROID_SHELL_MARKER = "LearnHarnessAndroid";

export function isAndroidShell(userAgent: string | undefined): boolean {
	return typeof userAgent === "string" && userAgent.includes(ANDROID_SHELL_MARKER);
}
