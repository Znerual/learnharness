/**
 * ANDROID BACK ACROSS BOTH LAYER SYSTEMS (owner F3): inside the Android shell
 * the back button (window.lhAndroidBack) closes the newest open layer —
 * whether it registered with useAndroidBack or lives in the interaction
 * layers (popover, host dialog, plugin layer). One press closes one layer.
 */
import React, { act, useEffect, useRef, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { AndroidShellProvider, useAndroidBack } from "../components/android-shell.tsx";
import { HostDialog } from "../components/host-dialog.tsx";
import { MenuShell } from "../components/menu-shell.tsx";
import { usePopoverDismiss } from "../components/popover-dismiss.ts";
import { usePluginMenuDismiss } from "../components/plugin-model-picker.tsx";
import { installModalDom } from "./modal-dom.ts";

type Back = () => boolean;

async function withAndroid(run: (render: (node: React.ReactNode, android?: boolean) => Promise<void>, back: Back) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const values = { React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
		getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }) };
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, values);
	const restore = installModalDom(dom);
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.querySelector("#root")!);
	try {
		await run(
			async (node, android = true) => { await act(async () => { root.render(<AndroidShellProvider android={android}><InteractionLayersProvider>{node}</InteractionLayersProvider></AndroidShellProvider>); }); },
			() => {
				const w = window as unknown as { lhAndroidBack?: Back };
				let result = false;
				// Only the page's own back handler; absent outside the shell.
				if (w.lhAndroidBack) act(() => { result = w.lhAndroidBack!(); });
				return result;
			},
		);
	} finally {
		await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 5)); });
		restore();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}
const click = async (testid: string) => { await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click(); }); };
const has = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) !== null;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });

function Popover({ testid = "popover" }: { testid?: string }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	usePopoverDismiss(root, open, () => setOpen(false));
	return <div ref={root}><button data-testid={`${testid}-trigger`} onClick={() => setOpen(true)}>open</button>{open && <div data-testid={testid}>panel</div>}</div>;
}
function Dialog({ children }: { children?: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	return <><button data-testid="dialog-trigger" onClick={() => setOpen(true)}>open</button>
		<HostDialog open={open} onClose={() => { setOpen(false); return "closed"; }} aria-label="Fixture"><div data-testid="dialog">{children}</div></HostDialog></>;
}
function PluginPicker() {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => { setOpen(true); }, []);
	const close = () => setOpen(false);
	usePluginMenuDismiss(open, root, close);
	return <div ref={root}><button>pick</button>{open && <MenuShell anchorRef={root} testid="plugin-menu" preferredSide="up" menuClass="fixture"
		onClose={() => { close(); return "closed"; }}><button>option</button></MenuShell>}</div>;
}
function ForkLayer() {
	const [open, setOpen] = useState(false);
	useAndroidBack(open, () => setOpen(false));
	return <><button data-testid="fork-trigger" onClick={() => setOpen(true)}>open</button>{open && <div data-testid="fork-layer">drawer</div>}</>;
}

test("back closes a popover, a host dialog and a plugin layer, then falls through when nothing is open", async () => withAndroid(async (render, back) => {
	await render(<><Popover /><Dialog /><PluginPicker /></>);
	await settle();
	assert(has("plugin-menu"));
	assert.equal(back(), true);
	assert.equal(has("plugin-menu"), false, "plugin layer");
	await click("popover-trigger");
	assert(has("popover"));
	assert.equal(back(), true);
	assert.equal(has("popover"), false, "popover");
	await click("dialog-trigger");
	assert(has("dialog"));
	assert.equal(back(), true);
	assert.equal(has("dialog"), false, "host dialog");
	assert.equal(back(), false, "nothing open: the page navigates as before");
}));

test("the newest layer wins across both systems, in both directions, one layer per press", async () => withAndroid(async (render, back) => {
	await render(<><ForkLayer /><Popover /></>);
	// fork layer first, interaction layer newer
	await click("fork-trigger");
	await click("popover-trigger");
	assert.equal(back(), true);
	assert.equal(has("popover"), false);
	assert(has("fork-layer"), "one press closes one layer");
	assert.equal(back(), true);
	assert.equal(has("fork-layer"), false);
	// interaction layer first, fork layer newer
	await click("popover-trigger");
	await click("fork-trigger");
	assert.equal(back(), true);
	assert.equal(has("fork-layer"), false);
	assert(has("popover"), "the older interaction layer stays open");
	assert.equal(back(), true);
	assert.equal(has("popover"), false);
	assert.equal(back(), false);
}));

test("a popover inside a host dialog closes before the dialog, and a fork layer above both closes first", async () => withAndroid(async (render, back) => {
	await render(<><Dialog><Popover /></Dialog><ForkLayer /></>);
	await click("dialog-trigger");
	await click("popover-trigger");
	await click("fork-trigger");
	assert.equal(back(), true);
	assert(!has("fork-layer") && has("popover") && has("dialog"));
	assert.equal(back(), true);
	assert(!has("popover") && has("dialog"));
	assert.equal(back(), true);
	assert.equal(has("dialog"), false);
	assert.equal(back(), false);
}));

test("outside the Android shell the interaction layers are not bridged", async () => withAndroid(async (render, back) => {
	await render(<Popover />, false);
	await click("popover-trigger");
	assert.equal(back(), false, "no lhAndroidBack on desktop");
	assert(has("popover"));
}));
