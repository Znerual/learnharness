/**
 * Update-banner render tests (Wave C, 2026-10-10): the banner is a pure
 * function of the shell's observational status — hidden without a bridge
 * or snapshot/event, visible with the downloaded
 * status, Restart wired to the bridge. The subscribe effect only runs
 * client-side, so the SSR pass pins the hidden state; the pushed state is
 * exercised by mounting with the bridge stubbed (classic-JSX shim as in
 * render-sidebar.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import UpdateBanner from "../components/update-banner.tsx";
import type { UpdateState } from "../components/settings/update-settings.tsx";

// linkedom as the DOM for the interactive pass (first createRoot test in
// the repo — the banner's push→render→click flow needs real effects).
// The window.lh bridge type is declared globally by components/sidebar.tsx.
const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;

describe("update banner (Wave C)", () => {
	afterEach(() => {
		delete (window as { lh?: unknown }).lh;
	});

	it("renders nothing with no bridge (browser / SSR)", () => {
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
	});

	it("renders nothing when the bridge exists but no status has arrived", () => {
		const listeners: Array<(s: UpdateState) => void> = [];
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => {
				listeners.push(cb);
				return () => {};
			},
			installUpdate: () => {},
		};
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
		void listeners;
	});

	it("shows the version + Restart once the downloaded push arrives, and Restart installs", async () => {
		let pushed: ((s: UpdateState) => void) | null = null;
		let installed = 0;
		(window as { lh?: unknown }).lh = {
			onUpdateStatus: (cb: (s: UpdateState) => void) => {
				pushed = cb;
				return () => {};
			},
			installUpdate: () => {
				installed += 1;
			},
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<UpdateBanner />));
		assert.equal(host.innerHTML, "", "hidden before the push");

		await new Promise((r) => setTimeout(r, 0));
		flushSync(() => pushed?.({ status: "downloaded", version: "0.3.1", revision: 1 }));
		assert.ok(host.innerHTML.includes("0.3.1"), "the version renders");
		assert.ok(host.innerHTML.includes("Restart"), "the restart affordance renders");

		const button = host.querySelector<HTMLButtonElement>("[data-testid='update-banner'] button");
		assert.ok(button, "restart button exists");
		button!.click();
		assert.equal(installed, 1, "Restart asks the shell to quit-and-install");
		root.unmount();
		host.remove();
	});

	it("offers What's new when the shell found changelog notes, as plain text", async () => {
		let pushed: ((s: UpdateState) => void) | null = null;
		(window as { lh?: unknown }).lh = { onUpdateStatus: (cb: (s: UpdateState) => void) => { pushed = cb; return () => {}; }, installUpdate: () => {} };
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<UpdateBanner />));
		await new Promise((r) => setTimeout(r, 0));
		flushSync(() => pushed?.({ status: "downloaded", version: "0.4.2108", revision: 1, notes: [
			{ version: "0.4.2108", released: "2026-11-02", notes: "- Restore a document by picking it\n- <b>not bold</b>" },
			{ version: "0.4.2107", released: "2026-11-02", notes: "" },
		] }));
		assert.equal(host.querySelector("[data-testid='update-banner-notes']"), null, "closed at first");
		host.querySelector<HTMLButtonElement>("[data-testid='update-banner-whats-new']")!.click();
		await new Promise((r) => setTimeout(r, 0));
		const notes = host.querySelector("[data-testid='update-banner-notes']");
		assert.ok(notes, "opens on click");
		assert.match(notes!.textContent!, /Version 0\.4\.2108/);
		assert.match(notes!.textContent!, /Restore a document by picking it/);
		assert.match(notes!.textContent!, /No notes were written for this version/);
		assert.equal(notes!.querySelector("b"), null, "never HTML");
		root.unmount();
		host.remove();
	});
});
