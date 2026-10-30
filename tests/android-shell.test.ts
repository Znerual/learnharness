/**
 * THE ANDROID SHELL MARKER (step 3): the phone layout applies only inside
 * the LearnHarness Android app, whose WebView appends "LearnHarnessAndroid"
 * to its user agent — never to a phone browser or a narrow desktop window.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAndroidShell } from "../src/core/android-shell.ts";

test("only the app's WebView user agent marks the Android shell", () => {
	assert.equal(isAndroidShell("Mozilla/5.0 (Linux; Android 16; 2510ERA8BG Build/BP2A; wv) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36 LearnHarnessAndroid/0.1.0"), true);
	assert.equal(isAndroidShell("Mozilla/5.0 (Linux; Android 16; 2510ERA8BG) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"), false, "a phone browser");
	assert.equal(isAndroidShell("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 LearnHarness/0.3.8 Chrome/141.0 Electron/38.0 Safari/537.36"), false, "the desktop app");
	assert.equal(isAndroidShell(undefined), false);
});
