/** The settings dialog on the phone: tab set and order, hidden desktop rows, on-device speech, data folder. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AndroidShellProvider } from "../components/android-shell.tsx";
import { SettingsDialogBody, visibleSections } from "../components/settings/settings-dialog.tsx";
import { AppearanceSection, GraphSection } from "../components/settings/appearance-section.tsx";
import { DataFolderSetting } from "../components/settings/device-settings.tsx";
import { OnDeviceSpeechGroup, modelStateLine, npuVoiceModel } from "../components/settings/on-device-speech.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);
type W = { LHAndroid?: unknown };

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}
const android = (el: React.ReactElement) => <AndroidShellProvider android>{el}</AndroidShellProvider>;

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
	delete (window as unknown as W).LHAndroid;
	globalThis.fetch = originalFetch;
});

const ids = (o: Parameters<typeof visibleSections>[0]) => visibleSections(o).map((s) => s.id);

describe("tabs", () => {
	it("phone: no Keyboard, most used first, Graph last, Session short", () => {
		assert.deepEqual(ids({ android: true, session: true, vault: true }), ["session", "keys", "agent", "dictation", "readAloud", "appearance", "general", "vault", "graph"]);
		assert.deepEqual(ids({ android: true, session: false, vault: false }), ["keys", "agent", "dictation", "readAloud", "appearance", "general", "graph"]);
		assert.equal(visibleSections({ android: true, session: true, vault: false })[0].label, "Session");
	});
	it("desktop keeps every tab in the old order", () => {
		assert.deepEqual(ids({ android: false, session: true, vault: true }), ["keys", "agent", "dictation", "readAloud", "appearance", "graph", "keyboard", "general", "vault"]);
	});
	it("the dialog renders the phone set", () => {
		const html = renderToStaticMarkup(android(<SettingsDialogBody onClose={() => {}} />));
		assert.ok(!html.includes("settings-nav-keyboard"));
		assert.ok(html.includes("settings-nav-graph"));
		assert.ok(renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />).includes("settings-nav-keyboard"));
	});
});

describe("desktop-only rows", () => {
	it("Mode and the Obsidian path are hidden on the phone and kept on desktop", () => {
		const a = renderToStaticMarkup(android(<><AppearanceSection appearance={undefined} onSectionChange={() => {}} /><GraphSection graph={undefined} onSectionChange={() => {}} /></>));
		assert.ok(!a.includes("row-mode") && !a.includes("graph-row-obsidian-vault"));
		assert.ok(a.includes("row-background") && a.includes("graph-row-enabled"));
		const d = renderToStaticMarkup(<><AppearanceSection appearance={undefined} onSectionChange={() => {}} /><GraphSection graph={undefined} onSectionChange={() => {}} /></>);
		assert.ok(d.includes("row-mode") && d.includes("graph-row-obsidian-vault"));
	});
});

const voice = (id: string, label: string, state: string, language = "en") => ({ id, kind: "voice", language, label, bytes: 60_000_000, state, progress: 0 });
const missing = { voice: "thorsten", label: "Piper Thorsten (high)", language: "de", state: "voice-missing" };

function fakeServer(opts: { models: unknown[]; npu: unknown }) {
	const calls: string[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/speech-models") return Response.json({ models: opts.models });
		if (url === "/api/npu-speech") return Response.json(opts.npu);
		return Response.json({ models: opts.models });
	}) as typeof fetch;
	return calls;
}

describe("on-device speech", () => {
	it("model rows say what to do next", () => {
		const m = { ...voice("a", "Piper", "missing") } as never;
		assert.equal(modelStateLine(m), "Not downloaded — 60 MB");
	});
	it("matches an NPU voice to its Piper download by label", () => {
		const models = [voice("v1", "Piper Thorsten (high)", "missing", "de")] as never[];
		assert.equal(npuVoiceModel(missing as never, models)?.id, "v1");
		assert.equal(npuVoiceModel(missing as never, []), undefined);
	});
	it("a missing voice shows which one and offers Download; no voice at all says what to do", async () => {
		const calls = fakeServer({
			models: [voice("voice-de", "Piper Thorsten (high)", "missing", "de")],
			npu: { offered: true, enabled: true, soc: "SM7635", voices: [missing] },
		});
		const host = await mount(android(<OnDeviceSpeechGroup part="read-aloud" />));
		await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		assert.match(q(host, "npu-no-voice")?.textContent ?? "", /needs a Piper voice/);
		assert.match(q(host, "npu-voice-thorsten")?.textContent ?? "", /Piper Thorsten \(high\) · Not downloaded/);
		await act(async () => { q(host, "npu-voice-download-thorsten")!.click(); });
		assert.ok(calls.includes("POST /api/speech-models/voice-de"));
	});
	it("with NPU off and a voice downloaded, no voice rows and no hint", async () => {
		fakeServer({
			models: [voice("voice-de", "Piper Thorsten (high)", "ready", "de")],
			npu: { offered: true, enabled: false, soc: "SM7635", voices: [{ ...missing, state: "off" }] },
		});
		const host = await mount(android(<OnDeviceSpeechGroup part="read-aloud" />));
		await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		assert.equal(q(host, "npu-no-voice"), null);
		assert.equal(q(host, "npu-voice-thorsten"), null);
	});
	it("a failed download offers Retry", async () => {
		fakeServer({ models: [voice("v", "Piper X", "failed")], npu: { offered: false, enabled: false, soc: "", voices: [] } });
		const host = await mount(android(<OnDeviceSpeechGroup part="read-aloud" />));
		await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		assert.equal(q(host, "speech-model-download-v")?.textContent, "Retry");
	});
});

describe("data folder switch", () => {
	const bridge = (over: object) => { (window as unknown as W).LHAndroid = { dataLocation: () => "private", setDataLocation: () => "", ...over }; };
	const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	it("is offered when shared folders are allowed", async () => {
		bridge({});
		globalThis.fetch = (async () => Response.json({ available: false })) as typeof fetch;
		const host = await mount(android(<DataFolderSetting />)); await settle();
		assert.ok(q(host, "data-folder-row"));
	});
	it("is hidden when the app says the edition cannot share, but kept for a phone already on it", async () => {
		bridge({ sharedFolderAllowed: () => false });
		const host = await mount(android(<DataFolderSetting />)); await settle();
		assert.equal(q(host, "data-folder-row"), null);
		bridge({ sharedFolderAllowed: () => false, dataLocation: () => "shared" });
		const host2 = await mount(android(<DataFolderSetting />)); await settle();
		assert.ok(q(host2, "data-folder-row"));
	});
	it("an unavailable answer is shown as a note", async () => {
		bridge({ sharedFolderAllowed: () => true, setDataLocation: () => "unavailable" });
		const host = await mount(android(<DataFolderSetting />)); await settle();
		await act(async () => { host.querySelector<HTMLElement>("[role=switch], input, button")!.click(); });
		assert.match(host.textContent ?? "", /private folder/);
	});
	it("is absent outside the app", async () => {
		const host = await mount(<DataFolderSetting />); await settle();
		assert.equal(q(host, "data-folder-row"), null);
	});
});
