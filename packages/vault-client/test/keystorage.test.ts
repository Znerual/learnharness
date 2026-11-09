import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeBundle, encodeBundle, type SecretBundle } from "../src/keystorage.ts";

const base: SecretBundle = {
	accountId: "acc", serverUrl: "https://x", deviceId: "d", deviceToken: "t", deviceSeed: null, deviceMethodId: null, generation: 1,
	rootKey: new Uint8Array(32).fill(1), ik: new Uint8Array(32).fill(2), vaultKeys: [new Uint8Array(32).fill(3)], highWater: { generation: 1, epoch: 1 },
};

test("bundle v2 round-trips pins and consumed methods", () => {
	const b = decodeBundle(encodeBundle({ ...base, pins: { m1: "AAAA" }, consumedMethods: ["BBBB"] }));
	assert.deepEqual(b.pins, { m1: "AAAA" });
	assert.deepEqual(b.consumedMethods, ["BBBB"]);
});

test("a v1 bundle loads with no pins", () => {
	const v1 = JSON.parse(encodeBundle(base)) as Record<string, unknown>;
	v1["v"] = 1;
	delete v1["pins"];
	delete v1["consumedMethods"];
	const b = decodeBundle(JSON.stringify(v1));
	assert.deepEqual(b.pins, {});
	assert.deepEqual(b.consumedMethods, []);
});
