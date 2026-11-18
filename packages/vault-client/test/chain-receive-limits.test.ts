// What another device of the account can make this device keep (ADR 0007, vault finding H-021).
// The sender checks the plugin limits before it pushes; a device that was taken over does not.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { ChangeRow } from "../src/api/types.ts";
import type { RecordHeader } from "../src/crypto/index.ts";
import { ChainSync, MAX_PENDING_PER_CHAIN, type ActivePlugin, type PluginFilesHost } from "../src/sync/chains.ts";
import type { Vault } from "../src/vault.ts";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const plugin: ActivePlugin = { origin: "community", id: "flash-cards", identity: { name: "Flashcards", source: "s" }, limits: { maxFileBytes: 1000, maxPluginBytes: 10_000, maxFiles: 3 } };
const sha = "ab".repeat(32);

async function chains(host: Partial<PluginFilesHost> = {}) {
	const stateDir = mkdtempSync(join(tmpdir(), "lh-chain-limits-"));
	dirs.push(stateDir);
	const c = new ChainSync({
		vault: {} as Vault, stateDir, deviceId: "dev_aaaaaaaa", now: () => new Date("2026-11-18T12:00:00Z"),
		openRecord: async () => { throw new Error("not used"); },
		host: { activePlugins: async () => [plugin], listPluginFiles: async () => [], readPluginFile: async () => null,
			withPluginStopped: async () => true, writePluginConflict: async () => undefined, ...host },
	});
	await c.init();
	// The plugin syncs on this device.
	(c as unknown as { state: { active: string[] } }).state.active.push("community/flash-cards");
	const pending = () => { try { return readdirSync(join(stateDir, "chains", "pending")).length; } catch { return 0; } };
	let n = 0;
	const receive = (rel: string, slot: number, size: number, bodyBytes = size) => {
		const recordId = (++n).toString(16).padStart(64, "0");
		const header = { kind: "doc", path: `pf/community/flash-cards/${rel}/${String(slot).padStart(12, "0")}`, baseSeq: 0, deleted: false, deviceId: "dev_bbbbbbbb",
			writtenAt: "2026-11-18T12:00:00Z", chain: { type: "full", size, sha256: sha } } as unknown as RecordHeader;
		return c.receive({ recordId, kind: "doc", seq: n, epoch: 1, size: bodyBytes, sha256: sha, tombstone: false, deviceId: null, deviceName: "x", createdAt: "" } as ChangeRow, header, new Uint8Array(bodyBytes));
	};
	return { c, receive, pending, refused: () => c.status().refused };
}

describe("receiving plugin files from another device", () => {
	it("keeps a slot within the limits and refuses one over the file size", async () => {
		const t = await chains();
		await t.receive("deck.json", 1, 900);
		assert.equal(t.pending(), 1);
		await t.receive("big.json", 1, 5000);
		await t.receive("lying.json", 1, 10, 5000); // declares 10 bytes, sends 5000
		assert.equal(t.pending(), 1, "nothing over the limit was written");
		assert.equal(t.refused(), 2);
	});

	it("refuses files beyond the plugin's file count", async () => {
		const t = await chains();
		for (const rel of ["a.json", "b.json", "c.json"]) await t.receive(rel, 1, 10);
		assert.equal(t.pending(), 3);
		await t.receive("d.json", 1, 10);
		assert.equal(t.pending(), 3);
		assert.equal(t.refused(), 1);
		await t.receive("a.json", 2, 10); // another slot of a known file is fine
		assert.equal(t.pending(), 4);
	});

	it("applies this device's own exclusion rules", async () => {
		const asked: string[] = [];
		const t = await chains({ acceptsPluginFile: (_p, rel) => { asked.push(rel); return !rel.startsWith("cache/"); } });
		await t.receive("cache/x.json", 1, 10);
		await t.receive("decks/x.json", 1, 10);
		assert.deepEqual(asked, ["cache/x.json", "decks/x.json"]);
		assert.equal(t.pending(), 1);
		assert.equal(t.refused(), 1);
	});

	it("bounds the slots that wait for their predecessors", async () => {
		const t = await chains();
		// Slots 2.. of one file never become consecutive, because slot 1 never arrives.
		for (let s = 2; s < MAX_PENDING_PER_CHAIN + 50; s++) await t.receive("deck.json", s, 1);
		assert.equal(t.pending(), MAX_PENDING_PER_CHAIN);
		assert.equal(t.refused(), 48);
	});
});
