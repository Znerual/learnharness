/**
 * READ-ALOUD PAUSE (voice mode, ADR-0005): a barge-in pauses read-aloud
 * and keeps the reply; continue replays the interrupted block from its
 * start and goes on; restart replays the whole reply from its first
 * block, also after a stop. Driven through the player's public functions
 * over a fake fetch and a fake Audio element.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

class FakeAudio {
	static playing: FakeAudio | null = null;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly src: string) {}
	play() {
		FakeAudio.playing = this;
		played.push(spoken.get(this.src) ?? "?");
		return Promise.resolve();
	}
	pause() {
		if (FakeAudio.playing === this) FakeAudio.playing = null;
	}
}

const played: string[] = [];
const spoken = new Map<string, string>();
let nextUrl = 0;
const globals = globalThis as Record<string, unknown>;
globals.Audio = FakeAudio;
globals.fetch = async (_url: string, init: { body: string }) => {
	const { segments } = JSON.parse(init.body) as { segments: { text: string }[] };
	return new Response(segments.map((s) => s.text).join(" "));
};
URL.createObjectURL = (() => {
	const url = `blob:${nextUrl++}`;
	return url;
}) as typeof URL.createObjectURL;
URL.revokeObjectURL = () => {};
// The fetched blob's text is what the block says: map url → text on creation.
const create = URL.createObjectURL;
const realBlob = Response.prototype.blob;
Response.prototype.blob = async function () {
	const blob = await realBlob.call(this);
	(blob as Blob & { said?: string }).said = await blob.text();
	return blob;
};
URL.createObjectURL = ((blob: Blob & { said?: string }) => {
	const url = (create as (b: Blob) => string)(blob);
	spoken.set(url, blob.said ?? "?");
	return url;
}) as typeof URL.createObjectURL;

const { speakReply, stopReadAloud, pauseReadAloud, resumeReadAloud, restartReadAloud, readAloudReading } = await import(
	"../components/read-aloud.tsx"
);

const blocks = ["One.", "Two.", "Three."].map((text) => [{ kind: "text" as const, text }]);

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const t0 = Date.now();
	while (!check()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out; played ${JSON.stringify(played)}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** The playing block finishes. */
function end(): void {
	const audio = FakeAudio.playing;
	assert.ok(audio, "a block is playing");
	FakeAudio.playing = null;
	audio.onended?.();
}

describe("read-aloud pause", () => {
	beforeEach(() => {
		stopReadAloud();
		played.length = 0;
	});

	it("continue replays the interrupted block from its start, then goes on", async () => {
		speakReply("turn-1", blocks);
		await until(() => played.length === 1);
		end();
		await until(() => played.length === 2);
		pauseReadAloud();
		assert.equal(readAloudReading(), "paused");
		assert.equal(FakeAudio.playing, null, "the playing block is cut");
		await new Promise((r) => setTimeout(r, 900));
		assert.deepEqual(played, ["One.", "Two."], "nothing plays while paused");
		resumeReadAloud();
		assert.equal(readAloudReading(), "playing");
		await until(() => played.length === 3);
		end();
		await until(() => played.length === 4);
		assert.deepEqual(played, ["One.", "Two.", "Two.", "Three."]);
	});

	it("restart replays the whole reply from its first block, also after a stop", async () => {
		speakReply("turn-2", blocks);
		await until(() => played.length === 1);
		end();
		await until(() => played.length === 2);
		stopReadAloud();
		assert.equal(readAloudReading(), "stopped");
		restartReadAloud();
		await until(() => played.length === 3);
		assert.deepEqual(played, ["One.", "Two.", "One."]);
	});

});
