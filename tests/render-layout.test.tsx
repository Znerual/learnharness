/**
 * First paint follows the theme end to end: the record and the theme
 * files on a temp LH_DATA_DIR → readThemeBoot (exactly what app/layout.tsx
 * spreads on <html>; the layout itself imports CSS and next/font, so it
 * cannot load under tsx) → the server-rendered <html>. And the status
 * chrome speaks the theme's tokens.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-layout-theme-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { readThemeBoot, systemBootScript, writeSettingsRecord, themeStore } = await import("../src/server/index.ts");
const { AnsweredCard } = await import("../components/answered-card.tsx");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** The <html> the layout renders from a boot (className + style). */
function html(): string {
	const { theme, vars } = readThemeBoot();
	return renderToStaticMarkup(
		<html className={theme.mode} style={vars as React.CSSProperties}>
			<body />
		</html>,
	);
}

describe("first paint follows the theme", () => {
	it("Rosé Pine Dawn renders light with its colors on <html>", () => {
		writeSettingsRecord({ version: 1, appearance: { theme: "rose-pine-dawn" } });
		const out = html();
		assert.match(out, /<html class="light"/);
		assert.match(out, /--background:#faf4ed/);
		assert.match(out, /--foreground:#575279/);
	});

	it("an imported theme paints from its file; overrides paint over it", () => {
		themeStore.writeTheme("my-paper", {
			name: "My Paper",
			mode: "light",
			colors: {
				background: "#fdfdfd", surface: "#ffffff", border: "#dddddd", text: "#222222", textMuted: "#666666",
				accent: "#3366ff", bold: "#222222", italic: "#222222", code: "#aa5500",
				error: "#cc0000", success: "#008800", warning: "#aa7700",
			},
		});
		writeSettingsRecord({ version: 1, appearance: { theme: "my-paper", colors: { warning: "#123456" } } });
		const out = html();
		assert.match(out, /<html class="light"/);
		assert.match(out, /--lh-accent:#3366ff/);
		assert.match(out, /--lh-warning:#123456/);
	});

	it("no record = System: the dark baseline on <html>, both variants for the pre-paint script", () => {
		// The fork keeps settings device-local (not under LH_DATA_DIR), so reset
		// through the store rather than removing a file in the data folder.
		writeSettingsRecord({ version: 1 });
		const boot = readThemeBoot();
		const out = html();
		assert.match(out, /<html class="dark"/);
		assert.match(out, /--background:#141414/);
		assert.deepEqual(boot.system && [boot.system.light.mode, boot.system.dark.mode], ["light", "dark"]);
		assert.equal(boot.system?.light.vars["--background"], "#fafafa", "the Light preset");
		assert.equal(boot.system?.dark.vars["--background"], "#141414");
	});

	it("a chosen theme has no System variants; a custom pair is read from its files", () => {
		writeSettingsRecord({ version: 1, appearance: { theme: "catppuccin-mocha" } });
		assert.equal(readThemeBoot().system, null);
		themeStore.writeTheme("my-paper", {
			name: "My Paper", mode: "light",
			colors: {
				background: "#fdfdfd", surface: "#ffffff", border: "#dddddd", text: "#222222", textMuted: "#666666",
				accent: "#3366ff", bold: "#222222", italic: "#222222", code: "#aa5500",
				error: "#cc0000", success: "#008800", warning: "#aa7700",
			},
		});
		writeSettingsRecord({ version: 1, appearance: { theme: "system", systemThemes: { light: "my-paper", dark: "gone" }, colors: { warning: "#123456" } } });
		const boot = readThemeBoot();
		assert.equal(boot.system?.light.vars["--background"], "#fdfdfd");
		assert.equal(boot.system?.light.vars["--lh-warning"], "#123456", "overrides apply on whichever theme shows");
		assert.equal(boot.system?.dark.vars["--background"], "#141414", "a gone slot falls back to Default");
		assert.deepEqual(boot.customs.map((t: { id: string }) => t.id), ["my-paper"]);
	});
});

describe("System first paint: the pre-paint script follows prefers-color-scheme", () => {
	/** Run the script against a fake <html> and a fixed OS scheme. */
	function paint(osDark: boolean) {
		writeSettingsRecord({ version: 1 });
		const { system } = readThemeBoot();
		const classes = new Set(["dark", "lh-android"]);
		const style: Record<string, string> = {};
		const documentElement = {
			classList: {
				remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
				add: (...c: string[]) => c.forEach((x) => classes.add(x)),
			},
			style: { setProperty: (k: string, v: string) => { style[k] = v; } },
		};
		new Function("document", "matchMedia", systemBootScript(system!))({ documentElement }, (q: string) => ({ matches: osDark && q.includes("dark") }));
		return { classes, style };
	}

	it("a dark OS paints the dark variant, a light OS the light one, keeping other classes", () => {
		const night = paint(true);
		assert.ok(night.classes.has("dark") && !night.classes.has("light") && night.classes.has("lh-android"));
		assert.equal(night.style["--background"], "#141414");
		const day = paint(false);
		assert.ok(day.classes.has("light") && !day.classes.has("dark") && day.classes.has("lh-android"));
		assert.equal(day.style["--background"], "#fafafa");
		assert.equal(day.style["--foreground"], "#1a1a1a");
	});

	it("a failing matchMedia leaves the server baseline alone, and the data cannot break out of the script tag", () => {
		const { system } = readThemeBoot();
		assert.doesNotThrow(() => new Function("document", "matchMedia", systemBootScript(system!))({}, () => { throw new Error("no"); }));
		const evil = { light: { mode: "light" as const, vars: { "--x": "</script><b>" } }, dark: system!.dark };
		assert.ok(!systemBootScript(evil).includes("</script>"));
	});
});

describe("status chrome speaks the theme tokens", () => {
	it("an answered quiz's correct chip uses the success token", () => {
		const out = renderToStaticMarkup(
			<AnsweredCard
				answer={{
					kind: "quiz", questionText: "2+2?", options: [{ index: 1, label: "4" }, { index: 2, label: "5" }],
					answers: [{ index: 1, label: "4", value: "a" }], correct: true, correctIndices: [1], dontKnow: false,
					answeredAt: "synthetic",
				}}
			/>,
		);
		assert.match(out, /data-slot="status-badge"[^>]*color:var\(--lh-success\);background-color:color-mix\(in oklab, var\(--lh-success\) 15%, transparent\)/);
		assert.doesNotMatch(out, /green-500/);
	});
});
