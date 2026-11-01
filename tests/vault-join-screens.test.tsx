import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToString } from "react-dom/server";
import type { DeviceRow } from "../src/core/vault/deps.ts";
import { initialDevices, reduceDevices } from "../src/core/vault/models/devices.ts";
import { initialJoiner, reduceJoiner } from "../src/core/vault/models/pairing.ts";
import { androidScannerAvailable, startAndroidScan } from "../components/vault/android-scan.ts";
import { DevicesView } from "../components/vault/Devices.tsx";
import { JoinView } from "../components/vault/Join.tsx";
import { LeaveVaultView } from "../components/vault/LeaveVault.tsx";
import { PairingJoinerView } from "../components/vault/Pairing.tsx";

const noop = () => undefined;
const NOW = new Date("2026-11-02T12:00:00Z");

// ---------------------------------------------------------------- the join screen

test("join: with local data it asks, names the count and the pre-vault folder, and offers use or cancel", () => {
	const html = renderToString(<JoinView email="learner@example.org" localFiles={12} busy={false} onUse={noop} onCancel={noop} />);
	assert.match(html, /Joining the vault of learner@example.org/);
	assert.match(html, /data-ask="true"/);
	assert.match(html, /holds 12 files/);
	assert.match(html, /pre-vault-&lt;date&gt;/);
	assert.match(html, /Nothing is deleted/);
	assert.match(html, />Use the vault</);
	assert.match(html, />Cancel and sign out</);
});

test("join: without local data it only offers to start or cancel, and says nothing about moved files", () => {
	const html = renderToString(<JoinView email="learner@example.org" localFiles={0} busy={false} onUse={noop} onCancel={noop} />);
	assert.match(html, /Joining the vault of learner@example.org/);
	assert.match(html, /data-ask="false"/);
	assert.match(html, />Start syncing</);
	assert.match(html, />Cancel and sign out</);
	assert.doesNotMatch(html, /pre-vault/);
});

test("join: one file is singular; both buttons are off while the answer is sent; an error shows", () => {
	assert.match(renderToString(<JoinView email="a@b.co" localFiles={1} busy={false} onUse={noop} onCancel={noop} />), /holds 1 file of its own/);
	const busy = renderToString(<JoinView email="a@b.co" localFiles={3} busy={true} error="network" onUse={noop} onCancel={noop} />);
	assert.equal((busy.match(/disabled=""/g) ?? []).length, 2);
	assert.match(busy, /could not reach the vault server/);
});

// ---------------------------------------------------------------- leaving and signing out

test("leave: the unpushed count is shown before the learner confirms", () => {
	const ask = renderToString(<LeaveVaultView unpushed={null} busy={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
	assert.match(ask, /Leave the vault on this device/);
	assert.doesNotMatch(ask, /leave-confirm/);
	const some = renderToString(<LeaveVaultView unpushed={4} busy={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
	assert.match(some, /data-count="4"/);
	assert.match(some, /4 changes have not been uploaded yet/);
	assert.match(some, />Sign out anyway</);
	const none = renderToString(<LeaveVaultView unpushed={0} busy={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
	assert.match(none, /Everything on this device has been uploaded/);
	assert.doesNotMatch(none, /Sign out anyway/);
	assert.match(renderToString(<LeaveVaultView unpushed={1} busy={false} onAsk={noop} onConfirm={noop} onCancel={noop} />), /1 change has not been uploaded yet/);
});

const me: DeviceRow = { id: "me", lhDeviceId: "dev_me", name: "This laptop", ephemeral: false, keysProtected: true, createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-11-02T11:00:00Z", current: true, established: true, hasUnlockMethod: true };
const actions = { renameSubmit: noop, signOut: noop, confirmPending: noop, cancelPending: noop, addDevice: noop };

test("devices: signing out this device warns about changes that never synced", () => {
	let s = reduceDevices(initialDevices(), { type: "loaded", devices: [me], pending: null, passkeys: 0 });
	s = reduceDevices(s, { type: "sign_out_ask" });
	const unknown = renderToString(<DevicesView state={s} dispatch={noop} now={NOW} actions={actions} />);
	assert.match(unknown, /Sign out this device\?/);
	assert.doesNotMatch(unknown, /data-testid="unpushed"/, "nothing claimed before the count is known");
	const some = renderToString(<DevicesView state={reduceDevices(s, { type: "unpushed", count: 2 })} dispatch={noop} now={NOW} actions={actions} />);
	assert.match(some, /2 changes have not been uploaded yet/);
	assert.match(some, />Sign out anyway</);
	const none = renderToString(<DevicesView state={reduceDevices(s, { type: "unpushed", count: 0 })} dispatch={noop} now={NOW} actions={actions} />);
	assert.match(none, /Everything on this device has been uploaded/);
	// a count that arrives after the dialog closed changes nothing
	assert.equal(reduceDevices(reduceDevices(s, { type: "action_cancel" }), { type: "unpushed", count: 5 }).action, null);
});

// ---------------------------------------------------------------- scanning (Android)

test("pairing joiner: the scan button exists only with a scanner; everyone can paste", () => {
	const view = (onScan?: () => void, state = initialJoiner) => renderToString(<PairingJoinerView state={state} dispatch={noop} onShow={noop} onJoin={noop} {...(onScan ? { onScan } : {})} />);
	assert.doesNotMatch(view(), /Scan the code with the camera/);
	assert.match(view(), /Scanned or pasted code/);
	assert.match(view(noop), /Scan the code with the camera/);
	const paste = reduceJoiner(initialJoiner, { type: "scan_mode" });
	assert.match(view(noop, paste), /Or paste the code the other device shows/);
	assert.match(view(undefined, paste), /Paste the code the other device shows, starting with lhv1-pair:/);
	assert.match(view(noop, reduceJoiner(initialJoiner, { type: "scan_started" })), /Waiting for the camera/);
	assert.match(view(noop, reduceJoiner(reduceJoiner(initialJoiner, { type: "scan_started" }), { type: "scan_failed", reason: 2 })), /camera is not allowed/);
});

type Fake = { LHAndroid?: { scanPairingCode?: () => void }; lhAndroidPairScan?: (r: unknown) => void };
const g = globalThis as unknown as { window?: Fake };
afterEach(() => {
	delete g.window;
});

test("android scanner: absent outside the app; present calls the bridge and receives lhAndroidPairScan once", () => {
	assert.equal(androidScannerAvailable(), false);
	g.window = {};
	assert.equal(androidScannerAvailable(), false);
	let opened = 0;
	g.window = { LHAndroid: { scanPairingCode: () => void opened++ } };
	assert.equal(androidScannerAvailable(), true);
	const got: unknown[] = [];
	startAndroidScan((r) => got.push(r));
	assert.equal(opened, 1);
	g.window.lhAndroidPairScan?.({ ok: true, payload: "lhv1-pair:x" });
	assert.deepEqual(got, [{ ok: true, payload: "lhv1-pair:x" }]);
	assert.equal(g.window.lhAndroidPairScan, undefined, "the callback is removed after the answer");
});

test("android scanner: a failure reason comes through; stopping removes the callback; a throwing bridge reports a failure", () => {
	g.window = { LHAndroid: { scanPairingCode: () => undefined } };
	const got: unknown[] = [];
	const stop = startAndroidScan((r) => got.push(r));
	g.window.lhAndroidPairScan?.({ ok: false, reason: 2 });
	assert.deepEqual([...got], [{ ok: false, reason: 2 }]);
	const stop2 = startAndroidScan((r) => got.push(r));
	stop2();
	assert.equal(g.window.lhAndroidPairScan, undefined);
	stop();
	g.window = { LHAndroid: { scanPairingCode: () => { throw new Error("no activity"); } } };
	const failed: unknown[] = [];
	startAndroidScan((r) => failed.push(r));
	assert.deepEqual(failed, [{ ok: false, reason: -1 }]);
	assert.equal(g.window.lhAndroidPairScan, undefined);
});
