/**
 * Read-aloud engines and voice clips (owner, 2026-11-09). Pinned: the
 * `speech.engine` setting (resolve, sanitize, strict parse), clip ids, the
 * recording-length reader (WAV header, MP3 frames), the clip checks, the
 * built-in engine's voices and clip store, the clip forward to a speech
 * server over a fake fetch, the pinned downloads, and the Settings status line.
 *
 * LH_DATA_DIR / LH_LOCAL_DIR / LH_AUTH_FILE redirect to a fresh tmp dir
 * BEFORE the server modules load.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speech-engine-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_LOCAL_DIR = path.join(TMP, "local");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_TTS_KEY;

const { isSpeechClipId, resolveSpeech, sanitizeSpeech, speechClipId } = await import("../src/core/speech.ts");
const { parseSpeechSettingsBody } = await import("../src/server/settings-body.ts");
const { audioSeconds, mp3Seconds, wavSeconds } = await import("../src/server/omnivoice/audio-length.ts");
const { checkClip } = await import("../src/server/omnivoice/clips.ts");
const { OMNIVOICE_MODEL_FILES, OMNIVOICE_PLATFORMS, omniVoicePlatform } = await import("../src/server/omnivoice/assets.ts");
const { OMNIVOICE_PRESETS } = await import("../src/server/omnivoice/presets.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { addSpeechClip, deleteSpeechClip, listSpeechVoices, synthesizeSpeech } = await import("../src/server/tts.ts");
const { clipVoices, engineStatusLine, formatBytes } = await import("../components/settings/speech-engine.tsx");
const { speechStatusLine } = await import("../components/settings/speech-rows.tsx");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A 16-bit mono PCM WAV of `seconds` at `rate`. */
function wav(seconds: number, rate = 16000): Uint8Array<ArrayBuffer> {
	const data = Math.round(seconds * rate) * 2;
	const out = new Uint8Array(44 + data);
	const view = new DataView(out.buffer);
	out.set(new TextEncoder().encode("RIFF"), 0);
	view.setUint32(4, 36 + data, true);
	out.set(new TextEncoder().encode("WAVEfmt "), 8);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	out.set(new TextEncoder().encode("data"), 36);
	view.setUint32(40, data, true);
	return out;
}

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frames (417 bytes, 1152 samples each), behind an ID3v2 tag. */
function mp3(frames: number): Uint8Array<ArrayBuffer> {
	const tag = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)];
	const out = new Uint8Array(tag.length + frames * 417);
	out.set(tag, 0);
	for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x00], tag.length + i * 417);
	return out;
}

describe("speech.engine", () => {
	it("defaults to the speech server and keeps a valid choice", () => {
		assert.equal(resolveSpeech(undefined).engine, "url");
		assert.equal(resolveSpeech({ engine: "builtin" }).engine, "builtin");
		assert.deepEqual(sanitizeSpeech({ engine: "builtin" }), { engine: "builtin" });
		assert.deepEqual(sanitizeSpeech({ engine: "cloud" }), {});
	});
	it("the strict parse refuses an unknown engine", () => {
		assert.deepEqual(parseSpeechSettingsBody({ engine: "builtin" }), { ok: true, settings: { engine: "builtin" } });
		const bad = parseSpeechSettingsBody({ engine: "cloud" });
		assert.equal(bad.ok, false);
	});
	it("the row's status line names no server for the built-in engine", () => {
		assert.equal(speechStatusLine({ engine: "builtin", language: "de", voice: "omni-male-low" }), "Deutsch · omni-male-low");
		assert.equal(speechStatusLine({ engine: "builtin" }), "English · default voice");
	});
});

describe("clip ids", () => {
	it("slugs the name", () => {
		assert.equal(speechClipId("My Voice"), "clip-my-voice");
		assert.equal(speechClipId("  Stimme & Ära!  "), "clip-stimme-ara");
		assert.equal(speechClipId("!!!"), null);
	});
	it("recognizes only well-formed clip ids", () => {
		assert.equal(isSpeechClipId("clip-my-voice"), true);
		assert.equal(isSpeechClipId("clip-My-Voice"), false);
		assert.equal(isSpeechClipId("clip-../x"), false);
		assert.equal(isSpeechClipId("omni-female-low"), false);
	});
});

describe("recording length", () => {
	it("reads a WAV header", () => {
		assert.equal(wavSeconds(wav(4)), 4);
		assert.deepEqual(audioSeconds(wav(2.5, 24000)), { kind: "wav", seconds: 2.5 });
	});
	it("walks MP3 frames behind an ID3 tag", () => {
		const seconds = mp3Seconds(mp3(154))!;
		assert.ok(Math.abs(seconds - (154 * 1152) / 44100) < 1e-9);
		assert.equal(audioSeconds(mp3(154))?.kind, "mp3");
	});
	it("refuses anything else", () => {
		assert.equal(audioSeconds(new TextEncoder().encode("not audio at all, really")), null);
	});
});

describe("clip checks", () => {
	const ok = { name: "My voice", transcript: "Hello there.", audio: wav(5) };
	it("accepts a 3–10 s recording with its words", () => {
		const r = checkClip(ok);
		assert.ok(r.ok);
		assert.equal(r.id, "clip-my-voice");
	});
	it("names what is wrong", () => {
		const code = (input: typeof ok) => {
			const r = checkClip(input);
			return r.ok ? null : r.code;
		};
		assert.equal(code({ ...ok, name: " " }), "invalid_name");
		assert.equal(code({ ...ok, transcript: " " }), "missing_transcript");
		assert.equal(code({ ...ok, audio: wav(2) }), "audio_too_short");
		assert.equal(code({ ...ok, audio: wav(11) }), "audio_too_long");
		assert.equal(code({ ...ok, audio: new TextEncoder().encode("nope nope nope nope") }), "invalid_audio");
	});
});

describe("the built-in engine", () => {
	it("offers the presets for every language, then the clips", async () => {
		writeSettings({ speech: { engine: "builtin" } });
		const listed = await listSpeechVoices();
		assert.ok(listed.ok);
		assert.deepEqual(listed.voices.map((v) => v.id), OMNIVOICE_PRESETS.map((p) => p.id));
		assert.ok(listed.voices.every((v) => v.language === null));

		const added = await addSpeechClip({ name: "My voice", transcript: "Hello there.", audio: wav(5) });
		assert.deepEqual(added, { ok: true, id: "clip-my-voice", name: "My voice" });
		assert.ok(fs.existsSync(path.join(TMP, "local", "speech-voices", "clip-my-voice", "audio.wav")));
		const again = await addSpeechClip({ name: "my VOICE", transcript: "Hi.", audio: wav(5) });
		assert.equal(again.ok ? null : again.code, "voice_exists");
		const withClip = await listSpeechVoices();
		assert.ok(withClip.ok);
		assert.equal(withClip.voices.at(-1)?.id, "clip-my-voice");
		assert.deepEqual(clipVoices(withClip.voices).map((v) => v.id), ["clip-my-voice"]);

		assert.deepEqual(await deleteSpeechClip("clip-my-voice"), { ok: true });
		assert.equal((await deleteSpeechClip("clip-my-voice")).ok, false);
		assert.ok(!fs.existsSync(path.join(TMP, "local", "speech-voices", "clip-my-voice")));
	});
	it("refuses to speak before the download, as a 503", async () => {
		writeSettings({ speech: { engine: "builtin" } });
		const r = await synthesizeSpeech([{ kind: "text", text: "Hallo." }]);
		assert.equal(r.ok, false);
		assert.equal(r.ok ? 0 : r.status, 503);
	});
});

describe("clips on a speech server", () => {
	it("forwards a checked clip as multipart, and passes refusals through", async () => {
		writeSettings({ speech: { url: "http://tts:8110/v1" } });
		const seen: { url: string; method: string; form: FormData | null }[] = [];
		const fake = (status: number, body: unknown) =>
			(async (url: string | URL, init?: RequestInit) => {
				seen.push({ url: String(url), method: init?.method ?? "GET", form: init?.body instanceof FormData ? init.body : null });
				return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			}) as typeof fetch;

		const r = await addSpeechClip({ name: "My voice", transcript: "Hello there.", audio: wav(5) }, fake(201, { id: "clip-my-voice", name: "My voice" }));
		assert.deepEqual(r, { ok: true, id: "clip-my-voice", name: "My voice" });
		assert.equal(seen.at(-1)?.url, "http://tts:8110/v1/audio/voices");
		assert.equal(seen.at(-1)?.form?.get("transcript"), "Hello there.");
		assert.ok(seen.at(-1)?.form?.get("audio") instanceof Blob);

		const exists = await addSpeechClip({ name: "My voice", transcript: "Hi.", audio: wav(5) }, fake(409, { error: { message: "exists", code: "voice_exists" } }));
		assert.deepEqual(exists, { ok: false, status: 409, error: "exists", code: "voice_exists" });
		const noClips = await addSpeechClip({ name: "My voice", transcript: "Hi.", audio: wav(5) }, fake(404, { detail: "Not Found" }));
		assert.equal(noClips.ok ? null : noClips.error, "This speech server does not take voice clips");
		// The checks run before anything is sent.
		const before = seen.length;
		const short = await addSpeechClip({ name: "My voice", transcript: "Hi.", audio: wav(1) }, fake(201, {}));
		assert.equal(short.ok ? null : short.code, "audio_too_short");
		assert.equal(seen.length, before);

		assert.deepEqual(await deleteSpeechClip("clip-my-voice", fake(204, null)), { ok: true });
		assert.equal(seen.at(-1)?.method, "DELETE");
		assert.equal(seen.at(-1)?.url, "http://tts:8110/v1/audio/voices/clip-my-voice");
		assert.equal((await deleteSpeechClip("omni-female-low", fake(204, null))).ok, false);
	});
});

describe("pinned downloads", () => {
	it("pins every file by size and SHA-256", () => {
		for (const platform of OMNIVOICE_PLATFORMS) {
			for (const file of [...platform.files, ...OMNIVOICE_MODEL_FILES]) {
				assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
				assert.ok(file.bytes > 0, file.path);
				assert.match(file.url, /^https:\/\//, file.path);
			}
		}
	});
	it("knows only the GPU platforms", () => {
		assert.equal(omniVoicePlatform("linux", "x64")?.device, "cuda");
		assert.equal(omniVoicePlatform("darwin", "arm64")?.device, "metal");
		assert.equal(omniVoicePlatform("android", "arm64"), null);
		assert.equal(omniVoicePlatform("darwin", "x64"), null);
	});
});

describe("Settings' engine status line", () => {
	const base = { supported: true, device: "cuda" as const, progress: 0, bytes: 4_754_000_000, running: false };
	it("says what state the download is in", () => {
		assert.equal(formatBytes(4_754_000_000), "4.8 GB");
		assert.equal(formatBytes(42_000_000), "42 MB");
		assert.equal(engineStatusLine({ ...base, state: "missing" }), "not downloaded · 4.8 GB");
		assert.equal(engineStatusLine({ ...base, state: "downloading", progress: 0.426 }), "downloading 42 %");
		assert.equal(engineStatusLine({ ...base, state: "ready", running: true }), "ready · CUDA · running");
		assert.equal(engineStatusLine({ ...base, supported: false, state: "missing" }), "not available");
	});
});

describe("picking libraries out of a wheel", () => {
	it("unpacks only the named files, flat, stored or deflated", async () => {
		const { deflateRawSync } = await import("node:zlib");
		const { unzipPicked } = await import("../src/server/omnivoice/unzip.ts");
		// A minimal zip: local headers, then the central directory, then its end record.
		const entries = [
			{ name: "nvidia/cublas/lib/libcublas.so.12", data: Buffer.from("cublas ".repeat(500)), method: 8 },
			{ name: "nvidia/cublas/lib/libnvblas.so.12", data: Buffer.from("nvblas"), method: 0 },
			{ name: "nvidia/curand/lib/libcurand.so.10", data: Buffer.from("curand"), method: 0 },
		];
		const locals: Buffer[] = [];
		const centrals: Buffer[] = [];
		let offset = 0;
		for (const e of entries) {
			const body = e.method === 8 ? deflateRawSync(e.data) : e.data;
			const name = Buffer.from(e.name);
			const local = Buffer.alloc(30);
			local.writeUInt32LE(0x04034b50, 0);
			local.writeUInt16LE(e.method, 8);
			local.writeUInt32LE(body.length, 18);
			local.writeUInt32LE(e.data.length, 22);
			local.writeUInt16LE(name.length, 26);
			const central = Buffer.alloc(46);
			central.writeUInt32LE(0x02014b50, 0);
			central.writeUInt16LE(e.method, 10);
			central.writeUInt32LE(body.length, 20);
			central.writeUInt32LE(e.data.length, 24);
			central.writeUInt16LE(name.length, 28);
			central.writeUInt32LE(offset, 42);
			locals.push(local, name, body);
			centrals.push(central, name);
			offset += 30 + name.length + body.length;
		}
		const directory = Buffer.concat(centrals);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(entries.length, 8);
		end.writeUInt16LE(entries.length, 10);
		end.writeUInt32LE(directory.length, 12);
		end.writeUInt32LE(offset, 16);
		const dir = fs.mkdtempSync(path.join(TMP, "wheel-"));
		const wheel = path.join(dir, "x.whl");
		fs.writeFileSync(wheel, Buffer.concat([...locals, directory, end]));
		const into = path.join(dir, "libs");
		fs.mkdirSync(into);
		await unzipPicked(wheel, into, ["libcublas.so.12", "libcurand.so.10"]);
		assert.deepEqual(fs.readdirSync(into).sort(), ["libcublas.so.12", "libcurand.so.10"]);
		assert.equal(fs.readFileSync(path.join(into, "libcublas.so.12"), "utf8"), "cublas ".repeat(500));
		await assert.rejects(unzipPicked(wheel, into, ["libcufft.so.11"]), /lacks libcufft/);
	});
});
