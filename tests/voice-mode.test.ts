/**
 * VOICE MODE (ADR-0005): the phone hands the page each utterance as a
 * voice command, dictated text, or noise; voiceAction decides what the
 * page does with it. Pinned: dictated text always lands in the dictation
 * target, a barge-in that was only noise resumes read-aloud, and each
 * voice command acts only where it means something (a refusal otherwise,
 * which the phone plays as the "refused" earcon).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { voiceAction, type VoiceContext } from "../src/core/voice-mode.ts";

const composer: VoiceContext = { target: "composer", reading: "idle", canReveal: false, canNext: false };

describe("voiceAction", () => {
	it("dictated text appends to whichever field holds the dictation target", () => {
		for (const target of ["composer", "question", "practice", "reading-thinking"] as const) {
			assert.deepEqual(voiceAction({ type: "text", text: "because it halves" }, { ...composer, target }), {
				type: "append",
				text: "because it halves",
			});
		}
	});

	it("noise resumes a read-aloud the barge-in paused, and does nothing otherwise", () => {
		assert.deepEqual(voiceAction({ type: "noise" }, { ...composer, reading: "paused" }), { type: "resume-reading" });
		assert.deepEqual(voiceAction({ type: "noise" }, { ...composer, reading: "playing" }), { type: "none" });
		assert.deepEqual(voiceAction({ type: "noise" }, composer), { type: "none" });
	});

	it("continue resumes a paused read-aloud; with nothing paused it is refused", () => {
		assert.deepEqual(voiceAction({ type: "command", command: "continue" }, { ...composer, reading: "paused" }), { type: "resume-reading" });
		assert.deepEqual(voiceAction({ type: "command", command: "continue" }, composer), { type: "refuse" });
	});

	it("restart replays the last reading from its first block, even after a stop", () => {
		for (const reading of ["paused", "playing", "stopped"] as const) {
			assert.deepEqual(voiceAction({ type: "command", command: "restart" }, { ...composer, reading }), { type: "restart-reading" });
		}
		assert.deepEqual(voiceAction({ type: "command", command: "restart" }, composer), { type: "refuse" });
	});

	it("stop ends a playing or paused read-aloud; with nothing to stop it is refused", () => {
		assert.deepEqual(voiceAction({ type: "command", command: "stop" }, { ...composer, reading: "paused" }), { type: "stop-reading" });
		assert.deepEqual(voiceAction({ type: "command", command: "stop" }, { ...composer, reading: "playing" }), { type: "stop-reading" });
		assert.deepEqual(voiceAction({ type: "command", command: "stop" }, { ...composer, reading: "stopped" }), { type: "refuse" });
	});

	it("send submits the dictation target; in the thinking-while-reading field it reveals the check", () => {
		assert.deepEqual(voiceAction({ type: "command", command: "send" }, composer), { type: "submit" });
		assert.deepEqual(voiceAction({ type: "command", command: "send" }, { ...composer, target: "question" }), { type: "submit" });
		assert.deepEqual(voiceAction({ type: "command", command: "send" }, { ...composer, target: "practice" }), { type: "submit" });
		assert.deepEqual(
			voiceAction({ type: "command", command: "send" }, { ...composer, target: "reading-thinking", canReveal: true }),
			{ type: "reveal" },
		);
	});

	it("reveal and next act only when the page offers them", () => {
		assert.deepEqual(voiceAction({ type: "command", command: "reveal" }, { ...composer, canReveal: true }), { type: "reveal" });
		assert.deepEqual(voiceAction({ type: "command", command: "reveal" }, composer), { type: "refuse" });
		assert.deepEqual(voiceAction({ type: "command", command: "next" }, { ...composer, canNext: true }), { type: "next" });
		assert.deepEqual(voiceAction({ type: "command", command: "next" }, composer), { type: "refuse" });
	});

	it("voice off always turns voice mode off", () => {
		assert.deepEqual(voiceAction({ type: "command", command: "voice-off" }, composer), { type: "voice-off" });
	});
});
