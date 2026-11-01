import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPairingCode, formatPairingText, initialApprover, initialJoiner, reduceApprover, reduceJoiner } from "../src/core/vault/models/pairing.ts";

test("approver: show, review the name and code, approve", () => {
	let s = reduceApprover(initialApprover, { type: "start" });
	assert.equal(s.busy, true);
	s = reduceApprover(s, { type: "shown", pairingId: "p1", qr: "lhv1-pair:x", text: "A".repeat(52) });
	assert.equal(s.step, "showing");
	s = reduceApprover(s, { type: "reviewed", name: "New phone", code: "123456" });
	assert.equal(s.step, "review");
	assert.equal(s.step === "review" && s.deviceName, "New phone");
	s = reduceApprover(s, { type: "approve" });
	assert.equal(s.busy, true);
	assert.equal(reduceApprover(s, { type: "reject" }), s, "cannot reject while approving");
	s = reduceApprover(s, { type: "approved" });
	assert.deepEqual(s, { step: "approved", busy: false, deviceName: "New phone" });
});

test("approver: approve is not reachable without a review", () => {
	const s = reduceApprover(reduceApprover(reduceApprover(initialApprover, { type: "start" }), { type: "shown", pairingId: "p1", qr: "q", text: "t" }), { type: "approve" });
	assert.equal(s.step, "showing");
});

test("approver: mismatched codes cancel", () => {
	let s = reduceApprover(initialApprover, { type: "start" });
	s = reduceApprover(s, { type: "shown", pairingId: "p1", qr: "q", text: "t" });
	s = reduceApprover(s, { type: "reviewed", name: "X", code: "111111" });
	assert.deepEqual(reduceApprover(s, { type: "reject" }), { step: "cancelled", busy: false });
});

test("approver: timeout ends the flow", () => {
	let s = reduceApprover(initialApprover, { type: "start" });
	s = reduceApprover(s, { type: "shown", pairingId: "p1", qr: "q", text: "t" });
	assert.deepEqual(reduceApprover(s, { type: "failed", code: "pairing_timeout" }), { step: "failed", busy: false, error: "pairing_timeout" });
});

test("approver: other errors keep the screen", () => {
	const s = reduceApprover(reduceApprover(initialApprover, { type: "start" }), { type: "failed", code: "network" });
	assert.equal(s.step, "idle");
	assert.equal(s.busy, false);
});

test("joiner shows its own code and finishes", () => {
	let s = reduceJoiner(initialJoiner, { type: "show_own" });
	s = reduceJoiner(s, { type: "shown", pairingId: "p", qr: "q", text: "t", code: "654321" });
	assert.equal(s.step === "showing" && s.code, "654321");
	assert.equal(reduceJoiner(s, { type: "finished" }).step, "done");
});

test("joiner scans: only a lhv1-pair payload is accepted", () => {
	let s = reduceJoiner(initialJoiner, { type: "scan_mode" });
	s = reduceJoiner(s, { type: "value_changed", value: "hello" });
	s = reduceJoiner(s, { type: "join" });
	assert.equal(s.busy, false);
	assert.equal(s.step === "scan" && s.error, "bad_code");
	s = reduceJoiner(s, { type: "value_changed", value: " lhv1-pair:https://v:id:abc " });
	s = reduceJoiner(s, { type: "join" });
	assert.equal(s.busy, true);
	s = reduceJoiner(s, { type: "joined", pairingId: "p", code: "123456" });
	assert.equal(s.step, "waiting");
	assert.equal(s.step === "waiting" && s.code, "123456");
	assert.equal(reduceJoiner(s, { type: "finished" }).step, "done");
});

test("joiner: a cancelled pairing (keys rotated) ends with a message", () => {
	const s = reduceJoiner(reduceJoiner(initialJoiner, { type: "scan_mode" }), { type: "failed", code: "pairing_cancelled" });
	assert.deepEqual(s, { step: "failed", busy: false, error: "pairing_cancelled" });
});

test("code formatting", () => {
	assert.equal(formatPairingCode("123456"), "123 456");
	assert.equal(formatPairingText("A".repeat(52)), Array(13).fill("AAAA").join(" "));
});
