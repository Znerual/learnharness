/**
 * SPEECH BENCHMARK (Android app, owner 2026-11-01): Settings → On-device
 * speech asks the phone's speech server how fast this phone runs its
 * models; the answer decides whether voice mode is offered. Pinned: the
 * call goes to <speech url>/benchmark with the speech key, a run answers
 * its result, a phone that never ran one answers null, and the server's
 * refusal comes back as the error.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speech-benchmark-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_TTS_KEY;

const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey } = await import("../src/server/keys.ts");
const { speechBenchmark } = await import("../src/server/speech-models.ts");

const result = {
	at: "2026-11-01T10:00:00Z",
	dictation: { provider: "cpu", rtf: 0.1 },
	voice: { provider: "cpu", rtf: 0.73 },
	voiceMode: true,
};

describe("speechBenchmark", () => {
	it("runs the phone's benchmark with the speech key and answers its result", async () => {
		writeSettings({ version: 1, speech: { url: "http://127.0.0.1:8110/v1" } });
		assert.ok(saveKey("LH_TTS_KEY", "sk-phone").ok);
		const calls: { url: string; method?: string; auth?: string }[] = [];
		const fake = (async (url: string, init: RequestInit) => {
			calls.push({ url, method: init.method, auth: (init.headers as Record<string, string>).Authorization });
			return Response.json({ result });
		}) as typeof fetch;
		assert.deepEqual(await speechBenchmark("POST", fake), { ok: true, result });
		assert.deepEqual(calls, [{ url: "http://127.0.0.1:8110/v1/benchmark", method: "POST", auth: "Bearer sk-phone" }]);
	});

	it("a phone that never ran the benchmark answers null", async () => {
		const fake = (async () => Response.json({ result: null })) as unknown as typeof fetch;
		assert.deepEqual(await speechBenchmark("GET", fake), { ok: true, result: null });
	});

	it("the phone's refusal comes back as the error", async () => {
		const fake = (async () =>
			Response.json({ error: { message: "Turn voice mode off before running the benchmark" } }, { status: 409 })) as unknown as typeof fetch;
		assert.deepEqual(await speechBenchmark("POST", fake), {
			ok: false,
			status: 502,
			error: "Turn voice mode off before running the benchmark",
		});
	});

	it("without a speech server there is nothing to ask", async () => {
		writeSettings({ version: 1 });
		const fake = (async () => assert.fail("no call")) as unknown as typeof fetch;
		assert.equal((await speechBenchmark("GET", fake)).ok, false);
	});
});

const { benchmarkLine } = await import("../components/settings/on-device-speech.tsx");

describe("benchmarkLine", () => {
	it("says voice mode waits for a first run", () => {
		assert.equal(benchmarkLine(null), "Not run yet — voice mode appears once a run finds this phone fast enough.");
	});

	it("names Kokoro and Piper apart, and says when Kokoro is too slow", () => {
		assert.equal(
			benchmarkLine({
				...result,
				kokoro: { engine: "kokoro", provider: "cpu", rtf: 1.1 },
				piper: { engine: "piper", provider: "cpu", rtf: 0.2 },
				voice: { engine: "piper", provider: "cpu", rtf: 0.2 },
				kokoroFast: false,
			}),
			"Fast enough for voice mode: dictation 0.10 s per second of audio (CPU), Kokoro 1.10 s per second of audio (CPU), Piper 0.20 s per second of audio (CPU). Kokoro is too slow here, so only the Piper voices are offered.",
		);
	});

	it("names the verdict, each model's speed and where it runs", () => {
		assert.equal(
			benchmarkLine({ ...result, voice: { provider: "nnapi", rtf: 0.5 } }),
			"Fast enough for voice mode: dictation 0.10 s per second of audio (CPU), read-aloud 0.50 s per second of audio (GPU/NPU).",
		);
		assert.equal(
			benchmarkLine({ ...result, voice: null, voiceMode: false }),
			"Too slow for voice mode: dictation 0.10 s per second of audio (CPU), read-aloud failed.",
		);
	});
});
