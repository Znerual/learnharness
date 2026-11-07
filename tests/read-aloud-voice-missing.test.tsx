/**
 * READ-ALOUD WITHOUT A VOICE (Android app, owner 2026-11-07): when the phone's speech server says
 * the voice is not downloaded, the composer's read-aloud toggle shows a notice with the reason and a
 * button to the voice downloads, visible without hovering (touch screens show no hints). Driven
 * through the real player over a fake fetch.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });

let reply: { status: number; body: unknown } = { status: 502, body: {} };
globalThis.fetch = (async (url: string) => {
	if (url === "/api/tts/speak") return Response.json(reply.body, { status: reply.status });
	return Response.json({});
}) as typeof fetch;

const { ReadAloudToggle, speakReply } = await import("../components/read-aloud.tsx");

const roots: Root[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
});
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`);

async function fail(body: unknown) {
	reply = { status: 502, body };
	// The player fails asynchronously: let it settle inside act, so React sees the update.
	await act(async () => {
		speakReply(`turn-${Math.random()}`, [[{ kind: "text", text: "Hello." }]]);
		await new Promise((r) => setTimeout(r, 50));
	});
}

async function mountToggle() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<ReadAloudToggle />));
}

describe("read-aloud with no voice on the phone", () => {
	it("shows why and offers the voice downloads; the button clears the notice", async () => {
		await mountToggle();
		await fail({ message: "Text-to-speech failed: The English read-aloud voice is not downloaded", code: "voice_not_downloaded" });
		assert.match(q("read-aloud-voice-missing")?.textContent ?? "", /No read-aloud voice is installed on this phone\./);
		assert.equal(q("read-aloud-voice-missing-open")?.textContent, "Download a voice");
		await act(async () => q("read-aloud-voice-missing-open")!.click());
		assert.equal(q("read-aloud-voice-missing"), null);
	});
	it("a voice still downloading says so, and Dismiss closes it", async () => {
		await mountToggle();
		await fail({ message: "Text-to-speech failed: The English read-aloud voice waits for Wi-Fi to download (40 %)", code: "voice_downloading" });
		assert.match(q("read-aloud-voice-missing")?.textContent ?? "", /waits for Wi-Fi to download \(40 %\)/);
		assert.equal(q("read-aloud-voice-missing-open")?.textContent, "Open voice settings");
		await act(async () => q("read-aloud-voice-missing-dismiss")!.click());
		assert.equal(q("read-aloud-voice-missing"), null);
	});
	it("other failures keep the old quiet error on the toggle", async () => {
		await mountToggle();
		await fail({ message: "Text-to-speech failed: HTTP 500" });
		assert.equal(q("read-aloud-voice-missing"), null);
		assert.equal(q("read-aloud-toggle")?.getAttribute("aria-label"), "Text-to-speech failed: HTTP 500");
	});
});
