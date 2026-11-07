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
const { speechBenchmark, listSpeechModels, setSpeechModelMobileData } = await import("../src/server/speech-models.ts");

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

describe("downloads over mobile data (owner, 2026-11-07)", () => {
	it("PUTs the choice to the phone and answers the list with it", async () => {
		writeSettings({ version: 1, speech: { url: "http://127.0.0.1:8110/v1" } });
		assert.ok(saveKey("LH_TTS_KEY", "sk-phone").ok);
		const calls: { url: string; method?: string; body?: unknown }[] = [];
		const fake = (async (url: string, init: RequestInit) => {
			calls.push({ url, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
			return Response.json({ models: [], mobileData: true });
		}) as typeof fetch;
		assert.deepEqual(await setSpeechModelMobileData(true, fake), { ok: true, models: [], mobileData: true });
		assert.deepEqual(calls, [{ url: "http://127.0.0.1:8110/v1/models", method: "PUT", body: { mobileData: true } }]);
	});
	it("an app build that does not say means Wi-Fi only", async () => {
		const fake = (async () => Response.json({ models: [] })) as unknown as typeof fetch;
		assert.deepEqual(await listSpeechModels(fake), { ok: true, models: [], mobileData: false });
	});
});

const { benchmarkLine } = await import("../components/settings/on-device-speech.tsx");

describe("benchmarkLine", () => {
	it("says voice mode waits for a first run", () => {
		assert.equal(benchmarkLine(null), "Not run yet — voice mode appears once a run finds this phone fast enough.");
	});

	it("names each engine and where it runs, and what is too slow to offer", () => {
		assert.equal(
			benchmarkLine({
				...result,
				kokoro: { engine: "kokoro", provider: "cpu", rtf: 1.1 },
				piperHigh: { engine: "piper-high", provider: "cpu", rtf: 0.95 },
				piperMedium: { engine: "piper-medium", provider: "cpu", rtf: 0.2 },
				voice: { engine: "piper-medium", provider: "cpu", rtf: 0.2 },
				kokoroFast: false,
				piperHighFast: false,
			}),
			"Fast enough for voice mode: dictation 0.10 s per second of audio (CPU), Kokoro 1.10 s per second of audio (CPU), " +
				"Piper high 0.95 s per second of audio (CPU), Piper medium 0.20 s per second of audio (CPU). " +
				"Too slow here, so not offered: Kokoro and the high-quality Piper voices.",
		);
		assert.match(benchmarkLine({ ...result, kokoro: { engine: "kokoro", provider: "gpu", rtf: 0.48 } }), /Kokoro 0\.48 s per second of audio \(GPU\)/);
		assert.match(benchmarkLine({ ...result, piperHigh: { engine: "piper-high", provider: "npu", rtf: 0.46 } }), /Piper high 0\.46 s per second of audio \(NPU\)/);
	});

	it("names the verdict, each model's speed and where it runs", () => {
		assert.equal(
			benchmarkLine({ ...result, voice: { provider: "nnapi", rtf: 0.5 } }),
			"Fast enough for voice mode: dictation 0.10 s per second of audio (CPU), read-aloud 0.50 s per second of audio (NNAPI).",
		);
		assert.equal(
			benchmarkLine({ ...result, voice: null, voiceMode: false }),
			"Too slow for voice mode: dictation 0.10 s per second of audio (CPU), read-aloud failed.",
		);
	});
});

const { npuSpeech } = await import("../src/server/speech-models.ts");
const { npuVoiceLine } = await import("../components/settings/on-device-speech.tsx");

describe("npuSpeech", () => {
	it("switches NPU speech on the phone with the speech key", async () => {
		writeSettings({ version: 1, speech: { url: "http://127.0.0.1:8110/v1" } });
		const status = { offered: true, enabled: true, soc: "SM7635", voices: [] };
		const calls: { url: string; method?: string; body?: unknown }[] = [];
		const fake = (async (url: string, init: RequestInit) => {
			calls.push({ url, method: init.method, body: init.body });
			return Response.json(status);
		}) as typeof fetch;
		assert.deepEqual(await npuSpeech("PUT", true, fake), { ok: true, status });
		assert.deepEqual(calls, [{ url: "http://127.0.0.1:8110/v1/npu", method: "PUT", body: '{"enabled":true}' }]);
	});
});

describe("npuVoiceLine", () => {
	it("says where each voice reads, and why the NPU failed", () => {
		const v = { voice: "thorsten", label: "Piper Thorsten (high)", language: "de" };
		assert.equal(npuVoiceLine({ ...v, state: "ready" }), "Reads on the NPU");
		assert.equal(npuVoiceLine({ ...v, state: "failed", error: "the NPU reading is 40 % as loud as the CPU's" }), "Reads on the CPU — the NPU reading is 40 % as loud as the CPU's");
		assert.equal(npuVoiceLine({ ...v, state: "compiling" }), "Compiling for this phone's chip — up to a few minutes, once");
	});
});
