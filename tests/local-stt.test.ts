/**
 * The local dictation engine (local-STT wave, owner 2026-10-24). Pinned:
 * the WAV encoder (byte-exact header, samples round-trip), the dictation
 * settings (resolve, sanitize, strict parse), the curated LH_STT_KEY, and
 * the server forward to an OpenAI-compatible endpoint over a fake fetch
 * (engine gate, missing URL, bearer + model fields, error passthrough,
 * unreachable).
 *
 * LH_DATA_DIR / LH_AUTH_FILE redirect to a fresh tmp dir BEFORE the
 * server modules load.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-stt-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_STT_KEY;

const { encodeWav } = await import("../components/dictation.tsx");
const { resolveDictation, sanitizeDictation } = await import("../src/core/dictation.ts");
const { parseDictationSettingsBody } = await import("../src/server/settings-body.ts");
const { validateKeyShape, AUTH_KEYS } = await import("../src/core/auth-keys.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey, deleteKey } = await import("../src/server/keys.ts");
const { dictationConfig, transcribeLocally } = await import("../src/server/stt.ts");
const { localSttStatusLine } = await import("../components/settings/dictation-engine.tsx");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("encodeWav", () => {
	it("writes a 16 kHz mono 16-bit PCM WAV with the frames in order", async () => {
		const blob = encodeWav([new Int16Array([1, -2]), new Int16Array([32767])]);
		assert.equal(blob.type, "audio/wav");
		const bytes = new DataView(await blob.arrayBuffer());
		const ascii = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => bytes.getUint8(o + i)));
		assert.equal(bytes.byteLength, 44 + 6);
		assert.deepEqual([ascii(0), ascii(8), ascii(12), ascii(36)], ["RIFF", "WAVE", "fmt ", "data"]);
		assert.equal(bytes.getUint32(4, true), 36 + 6);
		assert.equal(bytes.getUint16(20, true), 1); // PCM
		assert.equal(bytes.getUint16(22, true), 1); // mono
		assert.equal(bytes.getUint32(24, true), 16000);
		assert.equal(bytes.getUint32(28, true), 32000);
		assert.equal(bytes.getUint16(34, true), 16);
		assert.equal(bytes.getUint32(40, true), 6);
		assert.deepEqual([44, 46, 48].map((o) => bytes.getInt16(o, true)), [1, -2, 32767]);
	});
});

describe("dictation settings", () => {
	it("resolve to Deepgram by default", () => {
		assert.deepEqual(resolveDictation(undefined), { engine: "deepgram", localUrl: null, localModel: null });
	});
	it("sanitize leniently", () => {
		assert.deepEqual(sanitizeDictation({ engine: "local", localUrl: "http://h:1/v1/", localModel: " w " }), {
			engine: "local",
			localUrl: "http://h:1/v1",
			localModel: "w",
		});
		assert.deepEqual(sanitizeDictation({ engine: "cloud", localUrl: "ftp://x", localModel: 3 }), {});
	});
	it("parse strictly", () => {
		assert.deepEqual(parseDictationSettingsBody({ engine: "local", localUrl: "http://h:1/v1" }), {
			ok: true,
			settings: { engine: "local", localUrl: "http://h:1/v1" },
		});
		assert.deepEqual(parseDictationSettingsBody({ localUrl: "", localModel: "" }), { ok: true, settings: {} });
		assert.ok(!parseDictationSettingsBody({ engine: "whisper" }).ok);
		assert.ok(!parseDictationSettingsBody({ localUrl: "nope" }).ok);
		assert.ok(!parseDictationSettingsBody({ localModel: 3 }).ok);
	});
	it("the status line names host and model", () => {
		assert.equal(localSttStatusLine(undefined), "not set");
		assert.equal(localSttStatusLine({ localUrl: "http://localhost:8110/v1" }), "localhost:8110");
		assert.equal(localSttStatusLine({ localUrl: "http://localhost:8110/v1", localModel: "large-v3" }), "localhost:8110 · large-v3");
	});
	it("LH_STT_KEY is a curated key with paste hygiene only", () => {
		assert.ok(AUTH_KEYS.some((k) => k.id === "LH_STT_KEY"));
		assert.ok(validateKeyShape("LH_STT_KEY", "k").ok);
		assert.ok(!validateKeyShape("LH_STT_KEY", "a b").ok);
	});
});

describe("the forward to the local endpoint", () => {
	const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
	const seen: { url: string; auth?: string; form?: FormData }[] = [];
	const fake =
		(status: number, body: unknown, fail = false) =>
		async (url: string | URL | Request, init?: RequestInit) => {
			if (fail) throw new TypeError("fetch failed");
			seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization, form: init?.body as FormData });
			return new Response(JSON.stringify(body), { status });
		};

	it("refuses unless the engine is Local and a URL is set", async () => {
		writeSettings({ version: 1 });
		assert.deepEqual(await transcribeLocally(audio, fake(200, { text: "x" }) as typeof fetch), {
			ok: false,
			status: 409,
			error: "The dictation engine is not set to Local",
		});
		writeSettings({ version: 1, dictation: { engine: "local" } });
		const r = await transcribeLocally(audio, fake(200, { text: "x" }) as typeof fetch);
		assert.equal(!r.ok && r.status, 503);
	});
	it("posts the WAV with model, and the key as bearer when stored", async () => {
		writeSettings({ version: 1, dictation: { engine: "local", localUrl: "http://stt:8110/v1", localModel: "large-v3" } });
		assert.deepEqual(dictationConfig(), { engine: "local", localUrl: "http://stt:8110/v1", localModel: "large-v3" });
		assert.deepEqual(await transcribeLocally(audio, fake(200, { text: " Hallo Welt. " }) as typeof fetch), { ok: true, text: "Hallo Welt." });
		let call = seen.at(-1)!;
		assert.equal(call.url, "http://stt:8110/v1/audio/transcriptions");
		assert.equal(call.auth, undefined);
		assert.equal(call.form?.get("model"), "large-v3");
		assert.ok(call.form?.get("file") instanceof Blob);
		assert.ok(saveKey("LH_STT_KEY", "sk-local").ok);
		await transcribeLocally(audio, fake(200, { text: "x" }) as typeof fetch);
		call = seen.at(-1)!;
		assert.equal(call.auth, "Bearer sk-local");
		deleteKey("LH_STT_KEY");
	});
	it("passes endpoint errors through and names an unreachable endpoint", async () => {
		const failed = await transcribeLocally(audio, fake(503, { error: { message: "Nothing to transcribe with: no GPU" } }) as typeof fetch);
		assert.deepEqual(failed, { ok: false, status: 502, error: "Local speech-to-text failed: Nothing to transcribe with: no GPU" });
		const down = await transcribeLocally(audio, fake(0, null, true) as typeof fetch);
		assert.deepEqual(down, { ok: false, status: 502, error: "Local speech-to-text is unreachable (http://stt:8110/v1)" });
		const empty = await transcribeLocally(audio, fake(200, {}) as typeof fetch);
		assert.equal(!empty.ok && empty.error, "Local speech-to-text returned no text");
	});
});
