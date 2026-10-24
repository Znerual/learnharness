/**
 * Read-aloud (read-aloud wave, owner 2026-10-24). Pinned: the spoken
 * script (blocks, cues, callouts, math kept as LaTeX), the streaming
 * prefix (closedMarkdown — only final blocks are spoken), math in words
 * through Speech Rule Engine, the `speech` settings (resolve, sanitize,
 * strict parse), the curated LH_TTS_KEY, and the forward to an
 * OpenAI-compatible /audio/speech endpoint over a fake fetch.
 *
 * LH_DATA_DIR / LH_AUTH_FILE redirect to a fresh tmp dir BEFORE the
 * server modules load.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-aloud-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_TTS_KEY;

const { closedMarkdown, questionSpeechBlocks, speechBlocks, withLead, SPEECH_CUES } = await import("../src/core/speech-script.ts");
const { seededRandom, shuffleOptions, normalizeOptions } = await import("../src/core/question-core.ts");
const { speechStatusLine } = await import("../components/settings/speech-rows.tsx");
const { resolveSpeech, sanitizeSpeech } = await import("../src/core/speech.ts");
const { parseSpeechSettingsBody } = await import("../src/server/settings-body.ts");
const { validateKeyShape, AUTH_KEYS } = await import("../src/core/auth-keys.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey, deleteKey } = await import("../src/server/keys.ts");
const { listSpeechVoices, parseSpeechSegments, speakMath, speechConfig, speechText, synthesizeSpeech } = await import(
	"../src/server/tts.ts"
);

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const text = (t: string) => ({ kind: "text" as const, text: t });
const math = (latex: string) => ({ kind: "math" as const, latex });

describe("speechBlocks", () => {
	it("reads prose and headings, drops markup, keeps math as LaTeX", () => {
		assert.deepEqual(speechBlocks("## The **chain** rule\n\nIf $u = g(x)$, see [the docs](http://x)."), [
			[text("The chain rule.")],
			[text("If "), math("u = g(x)"), text(", see the docs.")],
		]);
	});
	it("gives display math its own block, legacy delimiters included", () => {
		assert.deepEqual(speechBlocks("Then\n\n$$\n\\frac{a}{b}\n$$\n\nand \\(x^2\\)."), [
			[text("Then")],
			[math("\\frac{a}{b}")],
			[text("and "), math("x^2"), text(".")],
		]);
	});
	it("replaces code, diagrams and tables with a cue", () => {
		const md = "```python\nprint(1)\n```\n\n```mermaid\ngraph TD\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
		assert.deepEqual(speechBlocks(md), [[text(SPEECH_CUES.code)], [text(SPEECH_CUES.diagram)], [text(SPEECH_CUES.table)]]);
	});
	it("reads callouts with their lead-in", () => {
		assert.deepEqual(speechBlocks("> [!IMPORTANT]\n> The *outer* one."), [[text("Key idea: The outer one.")]]);
		assert.deepEqual(speechBlocks("> [!TIP]\n> Try it."), [[text("Tip: Try it.")]]);
		assert.deepEqual(speechBlocks("> Plain quote."), [[text("Plain quote.")]]);
	});
	it("flattens list items to one block per paragraph", () => {
		assert.deepEqual(speechBlocks("1. First.\n2. Second.\n\n   More."), [[text("First.")], [text("Second.")], [text("More.")]]);
	});
	it("withLead prefixes the first block", () => {
		assert.deepEqual(withLead("Option 1:", speechBlocks("$x$ wins")), [[text("Option 1: "), math("x"), text(" wins")]]);
		assert.deepEqual(withLead("Option 2:", []), [[text("Option 2:")]]);
	});
});

describe("questionSpeechBlocks", () => {
	it("reads question, context, then options numbered in the dock's shuffled order", () => {
		const options = [{ label: "$x^2$" }, { label: "B" }, { label: "C" }];
		const shown = shuffleOptions(normalizeOptions(options), seededRandom("call-1")).map((o) => o.label);
		const blocks = questionSpeechBlocks("quiz", "call-1", { question: "Which?", details: "Think.", options });
		assert.deepEqual(blocks.slice(0, 2), [[text("Which?")], [text("Think.")]]);
		assert.deepEqual(
			blocks.slice(2),
			shown.map((label, i) => (label === "$x^2$" ? [text(`Option ${i + 1}: `), math("x^2")] : [text(`Option ${i + 1}: ${label}`)])),
		);
	});
	it("reads ask options in order with descriptions; explain has none", () => {
		const ask = questionSpeechBlocks("ask_user_question", "c", {
			question: "Pace?",
			options: [{ label: "Slow", description: "More examples." }, { label: "Fast" }],
		});
		assert.deepEqual(ask, [[text("Pace?")], [text("Option 1: Slow")], [text("More examples.")], [text("Option 2: Fast")]]);
		assert.deepEqual(questionSpeechBlocks("recall", "c", { question: "Explain it." }), [[text("Explain it.")]]);
	});
});

describe("closedMarkdown (streaming)", () => {
	it("keeps only blocks a blank line has closed", () => {
		assert.equal(closedMarkdown("a\n\nb\n\nc"), "a\n\nb\n");
		assert.equal(closedMarkdown("a\n\n"), "a\n");
		assert.equal(closedMarkdown("still growing"), "");
	});
	it("ignores blank lines inside code fences and display math", () => {
		assert.equal(closedMarkdown("p\n\n```\ncode\n\nmore"), "p\n");
		assert.equal(closedMarkdown("p\n\n$$\nx\n\ny\n"), "p\n");
		assert.equal(closedMarkdown("p\n\n$$\nx\n$$\n\nq"), "p\n\n$$\nx\n$$\n");
	});
	it("only ever adds blocks as the reply grows", () => {
		const full = "Intro.\n\n1. One.\n2. Two.\n\n$$\nx^2\n$$\n\n> [!NOTE]\n> End.\n\nTail";
		let before = 0;
		for (let i = 0; i <= full.length; i++) {
			const blocks = speechBlocks(closedMarkdown(full.slice(0, i)));
			assert.ok(blocks.length >= before, `shrank at ${i}`);
			assert.deepEqual(blocks, speechBlocks(full).slice(0, blocks.length), `unstable at ${i}`);
			before = blocks.length;
		}
	});
});

describe("math in words", () => {
	it("reads formulas in ClearSpeak", async () => {
		assert.equal(await speakMath("\\frac{a}{b} + x^2"), "a over b plus x squared");
		assert.equal(await speakMath("\\sum_{i=1}^{n} i^2"), "the sum from i equals 1 to n of i squared");
	});
	it("says 'a formula' for LaTeX KaTeX cannot parse", async () => {
		assert.equal(await speakMath("\\frac{x"), "a formula");
	});
	it("joins a block into one sentence", async () => {
		assert.equal(await speechText([text("If "), math("u = g(x)"), text(", then.")]), "If u equals g of x, then.");
	});
	it("parses request segments strictly", () => {
		assert.deepEqual(parseSpeechSegments([text("a"), math("x")]), [text("a"), math("x")]);
		assert.equal(parseSpeechSegments([]), null);
		assert.equal(parseSpeechSegments([{ kind: "text" }]), null);
		assert.equal(parseSpeechSegments("a"), null);
	});
});

describe("speech settings", () => {
	it("resolve to off with no URL", () => {
		assert.deepEqual(resolveSpeech(undefined), { url: null, voice: null, speed: 1, autoRead: false });
	});
	it("sanitize leniently", () => {
		assert.deepEqual(sanitizeSpeech({ url: "http://h:1/v1/", voice: " af_heart ", speed: 1.5, autoRead: true }), {
			url: "http://h:1/v1",
			voice: "af_heart",
			speed: 1.5,
			autoRead: true,
		});
		assert.deepEqual(sanitizeSpeech({ url: "ftp://x", voice: 3, speed: 9, autoRead: "yes" }), {});
	});
	it("parse strictly", () => {
		assert.deepEqual(parseSpeechSettingsBody({ url: "http://h:1/v1", speed: 0.5, autoRead: false }), {
			ok: true,
			settings: { url: "http://h:1/v1", speed: 0.5, autoRead: false },
		});
		assert.deepEqual(parseSpeechSettingsBody({ url: "", voice: "" }), { ok: true, settings: {} });
		assert.ok(!parseSpeechSettingsBody({ url: "nope" }).ok);
		assert.ok(!parseSpeechSettingsBody({ speed: 5 }).ok);
		assert.ok(!parseSpeechSettingsBody({ autoRead: 1 }).ok);
	});
	it("the status line names host, voice and a non-default speed", () => {
		assert.equal(speechStatusLine(undefined), "not set");
		assert.equal(speechStatusLine({ url: "http://localhost:8110/v1" }), "localhost:8110");
		assert.equal(speechStatusLine({ url: "http://localhost:8110/v1", voice: "af_heart", speed: 1.2 }), "localhost:8110 · af_heart · 1.2×");
	});
	it("LH_TTS_KEY is a curated key with paste hygiene only", () => {
		assert.ok(AUTH_KEYS.some((k) => k.id === "LH_TTS_KEY"));
		assert.ok(validateKeyShape("LH_TTS_KEY", "k").ok);
		assert.ok(!validateKeyShape("LH_TTS_KEY", "a b").ok);
	});
});

describe("the forward to the speech endpoint", () => {
	const seen: { url: string; auth?: string; body?: Record<string, unknown> }[] = [];
	const fake =
		(status: number, body: BodyInit | null, fail = false) =>
		async (url: string | URL | Request, init?: RequestInit) => {
			if (fail) throw new TypeError("fetch failed");
			seen.push({
				url: String(url),
				auth: (init?.headers as Record<string, string>).Authorization,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			return new Response(body, { status, headers: { "content-type": status === 200 ? "audio/mpeg" : "application/json" } });
		};

	it("refuses without a URL", async () => {
		writeSettings({ version: 1 });
		const r = await synthesizeSpeech([text("hi")], fake(200, "ID3") as typeof fetch);
		assert.deepEqual(r, { ok: false, status: 503, error: "Read-aloud needs a text-to-speech URL" });
	});
	it("posts the spoken text with voice and speed, the key as bearer when stored", async () => {
		writeSettings({ version: 1, speech: { url: "http://tts:8110/v1", voice: "af_heart", speed: 1.25 } });
		assert.deepEqual(speechConfig(), { url: "http://tts:8110/v1", voice: "af_heart", speed: 1.25, autoRead: false });
		const r = await synthesizeSpeech([text("So "), math("x^2")], fake(200, "ID3") as typeof fetch);
		assert.ok(r.ok);
		assert.equal(r.contentType, "audio/mpeg");
		assert.equal(await new Response(r.body).text(), "ID3");
		let call = seen.at(-1)!;
		assert.equal(call.url, "http://tts:8110/v1/audio/speech");
		assert.equal(call.auth, undefined);
		assert.deepEqual(call.body, { model: "tts-1", input: "So x squared", response_format: "mp3", speed: 1.25, voice: "af_heart" });
		assert.ok(saveKey("LH_TTS_KEY", "sk-tts").ok);
		await synthesizeSpeech([text("hi")], fake(200, "ID3") as typeof fetch);
		call = seen.at(-1)!;
		assert.equal(call.auth, "Bearer sk-tts");
		deleteKey("LH_TTS_KEY");
	});
	it("passes endpoint errors through and names an unreachable endpoint", async () => {
		const failed = await synthesizeSpeech(
			[text("hi")],
			fake(503, JSON.stringify({ error: { message: "Nothing to speak with" } })) as typeof fetch,
		);
		assert.deepEqual(failed, { ok: false, status: 502, error: "Text-to-speech failed: Nothing to speak with" });
		const down = await synthesizeSpeech([text("hi")], fake(0, null, true) as typeof fetch);
		assert.deepEqual(down, { ok: false, status: 502, error: "Text-to-speech is unreachable (http://tts:8110/v1)" });
		const empty = await synthesizeSpeech([text("  ")], fake(200, "ID3") as typeof fetch);
		assert.deepEqual(empty, { ok: false, status: 400, error: "Nothing to read aloud" });
	});
	it("lists voice names, objects or strings", async () => {
		const r = await listSpeechVoices(fake(200, JSON.stringify({ voices: ["af_heart", { id: "am_adam" }] })) as typeof fetch);
		assert.deepEqual(r, { ok: true, voices: ["af_heart", "am_adam"] });
	});
});
