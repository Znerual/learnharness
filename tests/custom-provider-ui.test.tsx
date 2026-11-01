import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KeysSection, CustomEndpointSetup } from "../components/settings/keys-section.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
const STATUS = { id: "custom", name: "Fixture endpoint", thinkingFormat: "openai", baseUrl: "http://fixture.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "fixture-model" }], overrides: {}, manualModels: [], revision: '"fixture"' };
async function mount(setup = false, statuses: object[] = [STATUS]) {
	globalThis.fetch = async (input, init) => {
		assert.equal(init?.method ?? "GET", "GET", "polish interactions must not save credentials/settings");
		const url = String(input);
		if (url === "/api/custom-providers") return Response.json({ providers: statuses });
		if (url.startsWith("/api/custom-providers/")) return Response.json(statuses[0], { headers: { etag: '"fixture"' } });
		return Response.json({ keys: [], providers: [] });
	};
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(setup ? <CustomEndpointSetup onSaved={() => assert.fail("unexpected save")} /> : <KeysSection />));
	if (!setup) await click("custom-endpoint-row-btn");
}
function element(id: string) { const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(node, id); return node; }
async function click(id: string) { await act(async () => element(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }))); }
async function selectMode(value: string) {
	const select = element("custom-auth-mode");
	Object.defineProperty(select, "value", { value, configurable: true });
	await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });
async function typeName(value: string) {
	const input = element("custom-name-input");
	Object.defineProperty(input, "value", { value, configurable: true });
	await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
}
for (const setup of [false, true]) {
	test(`${setup ? "Setup" : "Settings"} hides key input in Keyless and reveals it only in API key mode`, async () => {
		await mount(setup);
		assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		await selectMode("apiKey"); assert.equal(element("custom-key-input").getAttribute("type"), "password");
		await selectMode("keyless"); assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		assert.ok(element("custom-save"));
	});
}
test("model controls use approved effort labels, right-align Save limits, and group help below", async () => {
	await mount();
	const select = element("custom-pin-reasoning-fixture-model");
	assert.equal(select.getAttribute("aria-label"), "fixture-model reasoning effort support");
	assert.deepEqual(Array.from(select.children).map(option => option.textContent), ["Reasoning effort: Use reported", "Reasoning effort: Supported", "Reasoning effort: Not supported"]);
	assert.deepEqual(Array.from(select.children).map(option => option.getAttribute("value")), ["", "on", "off"], "capability values unchanged");
	const save = element("custom-pins-save"); assert.ok(save.classList.contains("ml-auto")); assert.equal(save.parentElement!.lastElementChild, save);
	const help = element("custom-help"); assert.equal(element("custom-budget-help").parentElement, help); assert.equal(element("custom-reasoning-help").parentElement, help);
	const children = Array.from(element("custom-endpoint-editor").children); assert.ok(children.indexOf(help) > children.indexOf(element("custom-pins")));
	assert.match(help.textContent ?? "", /do not resize backend context/); assert.match(help.textContent ?? "", /Off may not disable/);
});
test("every configured endpoint renders its own row; Add stays offered while one is configured", async () => {
	await mount(false, [STATUS, { ...STATUS, id: "lab-gpu", name: "Lab GPU" }]);
	assert.deepEqual(Array.from(document.querySelectorAll("[data-endpoint-id]")).map(node => node.getAttribute("data-endpoint-id")), ["custom", "lab-gpu"]);
	assert.equal(document.querySelectorAll('[data-testid="custom-endpoint-row"]').length, 2);
	assert.match(element("add-provider").textContent ?? "", /1/, "Custom endpoint is always addable");
});
test("a new endpoint cannot connect without a name", async () => {
	await mount(true);
	await selectMode("keyless");
	assert.equal(element("custom-save").hasAttribute("disabled"), true);
	assert.equal(element("custom-name-input").getAttribute("aria-label"), "Custom endpoint name");
	assert.ok(element("custom-thinking-format"));
});
