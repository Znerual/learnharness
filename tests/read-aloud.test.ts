/**
 * Read-aloud (read-aloud wave, owner 2026-10-24). Pinned: the spoken
 * script (blocks, cues, callouts, math kept as LaTeX), the streaming
 * prefix (closedMarkdown — only final blocks are spoken), math in words
 * through Speech Rule Engine with the owner's readings (math-speech
 * wave: plain subscripts, worded brackets, implied times, comma pauses
 * after compound groups), the `speech` settings (resolve, sanitize,
 * strict parse), the curated LH_TTS_KEY, and the forward to an
 * OpenAI-compatible /audio/speech endpoint over a fake fetch.
 *
 * LH_DATA_DIR / LH_AUTH_FILE redirect to a fresh tmp dir BEFORE the
 * server modules load.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-aloud-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
delete process.env.LH_TTS_KEY;

const { closedMarkdown, questionSpeechBlocks, replyTurns, speechBlocks, withLead, SPEECH_CUES } = await import(
	"../src/core/speech-script.ts"
);
const { seededRandom, shuffleOptions, normalizeOptions } = await import("../src/core/question-core.ts");
const { speechStatusLine } = await import("../components/settings/speech-rows.tsx");
const { resolveSpeech, sanitizeSpeech, speechVoice, voicesFor } = await import("../src/core/speech.ts");
const { parseSpeechSettingsBody } = await import("../src/server/settings-body.ts");
const { validateKeyShape, AUTH_KEYS } = await import("../src/core/auth-keys.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { saveKey, deleteKey } = await import("../src/server/keys.ts");
const { listSpeechVoices, parseSpeechSegments, speechConfig, speechText, synthesizeSpeech } = await import(
	"../src/server/tts.ts"
);
const { patchLocale, speakMath } = await import("../src/server/math-speech.ts");

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
	it("reads arrows as words with a pause around them, inline code included", () => {
		assert.deepEqual(speechBlocks("Heat → expansion --> cracks."), [[text("Heat, leads to, expansion, leads to, cracks.")]]);
		assert.deepEqual(speechBlocks("Rain -> wet, `x => x + 1`, A ⇒ B."), [[text("Rain, leads to, wet, x, implies, x + 1, A, implies, B.")]]);
		assert.deepEqual(speechBlocks("Output ← input, a <- b."), [[text("Output, comes from, input, a, comes from, b.")]]);
		assert.deepEqual(speechBlocks("Word ↔ meaning, a <-> b, P ⇔ Q."), [
			[text("Word, corresponds to, meaning, a, corresponds to, b, P, if and only if, Q.")],
		]);
		assert.deepEqual(speechBlocks("→ Next step."), [[text("leads to, Next step.")]]);
	});
	it("withLead prefixes the first block", () => {
		assert.deepEqual(withLead("Option 1:", speechBlocks("$x$ wins")), [[text("Option 1: "), math("x"), text(" wins")]]);
		assert.deepEqual(withLead("Option 2:", []), [[text("Option 2:")]]);
	});
});

describe("questionSpeechBlocks", () => {
	const spoken = (pauseBefore: string, ...block: Array<ReturnType<typeof text> | ReturnType<typeof math>>) => ({ block, pauseBefore });

	it("leads in, reads context, then options numbered in the dock's shuffled order, each set apart", () => {
		const options = [{ label: "$x^2$" }, { label: "B" }, { label: "C" }];
		const shown = shuffleOptions(normalizeOptions(options), seededRandom("call-1")).map((o) => o.label);
		const blocks = questionSpeechBlocks("quiz", "call-1", { question: "Which?", details: "Think.", options });
		assert.deepEqual(blocks.slice(0, 2), [spoken("question", text("And now the question: Which?")), spoken("paragraph", text("Think."))]);
		assert.deepEqual(
			blocks.slice(2),
			shown.map((label, i) =>
				label === "$x^2$" ? spoken("option", text(`Option ${i + 1}: `), math("x^2")) : spoken("option", text(`Option ${i + 1}: ${label}`)),
			),
		);
	});
	it("reads ask options in order, a description a paragraph after its label", () => {
		const ask = questionSpeechBlocks("ask_user_question", "c", {
			question: "Pace?",
			options: [{ label: "Slow", description: "More examples." }, { label: "Fast" }],
		});
		assert.deepEqual(ask, [
			spoken("question", text("And now the question: Pace?")),
			spoken("option", text("Option 1: Slow")),
			spoken("paragraph", text("More examples.")),
			spoken("option", text("Option 2: Fast")),
		]);
	});
	it("sets explain and recall apart without the lead-in", () => {
		assert.deepEqual(questionSpeechBlocks("recall", "c", { question: "Explain it." }), [spoken("question", text("Explain it."))]);
		assert.deepEqual(questionSpeechBlocks("explain", "c", { question: "Why?", details: "In words." }), [
			spoken("question", text("Why?")),
			spoken("paragraph", text("In words.")),
		]);
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

describe("replyTurns (per-turn read-aloud)", () => {
	const textPart = (t: string) => ({ type: "text", text: t });
	const quiz = (state: string) => ({ type: "tool-quiz", toolCallId: "q1", state });
	const group = (...parts: Array<Record<string, unknown>>) => ({ id: "a1", role: "assistant" as const, parts: parts as never });

	it("splits a group after each answered question", () => {
		const turns = replyTurns(group({ type: "step-start" }, textPart("Intro."), quiz("output-available"), { type: "step-start" }, textPart("Feedback.")));
		assert.deepEqual(turns, [
			{ key: "a1:0", start: 0, end: 3, text: "Intro." },
			{ key: "a1:1", start: 3, end: 5, text: "Feedback." },
		]);
	});
	it("keeps an unanswered question inside its turn", () => {
		const turns = replyTurns(group({ type: "step-start" }, textPart("Intro."), quiz("input-available")));
		assert.deepEqual(turns, [{ key: "a1:0", start: 0, end: 3, text: "Intro." }]);
	});
	it("adds no empty turn after a closing answer, and keeps keys as turns append", () => {
		const before = replyTurns(group(textPart("Intro."), quiz("output-available")));
		const after = replyTurns(group(textPart("Intro."), quiz("output-available"), textPart("Next.")));
		assert.deepEqual(before.map((t) => t.key), ["a1:0"]);
		assert.deepEqual(after.map((t) => t.key), ["a1:0", "a1:1"]);
		assert.equal(after[1]!.text, "Next.");
	});
	it("gives a message with no parts one empty turn", () => {
		assert.deepEqual(replyTurns(group()), [{ key: "a1:0", start: 0, end: 0, text: "" }]);
	});
});

describe("math in words", () => {
	it("reads formulas in ClearSpeak", async () => {
		assert.equal(await speakMath("\\frac{a}{b} + x^2"), "a over b plus x squared");
		assert.equal(await speakMath("\\sum_{i=1}^{n} i^2"), "the sum from i equals 1 to n of i squared");
	});
	it("reads formulas the owner's way", async () => {
		const readings: [string, string][] = [
			["m_t", "m t"],
			["\\beta_1", "beta 1"],
			["m_{t-1} + 1", "m t minus 1, plus 1"],
			["x_{ij}", "x i j"],
			["(1-\\beta_1) g_t", "parenthesis 1 minus beta 1, times g t"],
			["[a,b]", "bracket a comma b"],
			["\\{a+b\\} c", "brace a plus b, times c"],
			["2(x+1)", "2 times parenthesis x plus 1"],
			["f(x+1)", "f of x plus 1"],
			["\\max(a,b)", "max of a comma b"],
			["ab", "a times b"],
			["w_i x_i", "w i times x i"],
			["2x", "2 x"],
			["3ab", "3 a times b"],
			["\\frac{dy}{dx}", "d y over d x"],
			["\\sigma(Wx+b)", "sigma times parenthesis W times x plus b"],
			["\\frac{a+1}{b}", "fraction a plus 1, over b"],
			["\\frac{a}{b}", "a over b"],
			["e^{-x^2}", "e to the negative x squared"],
			["x^{n+1} + 1", "x to the n plus 1, plus 1"],
			["x^2", "x squared"],
			["x^n", "x to the n-th power"],
			["\\infty", "infinity"],
			["\\mathrm{ReLU}(x)", "ReLU of x"],
			["\\bar x", "x bar"],
			["\\vec v", "vector v"],
			["\\|w\\|", "the norm of w"],
			["\\|w\\|_2", "the norm of w, 2"],
			["\\ln x", "natural log of x"],
			["\\lim_{n\\to\\infty} a_n", "the limit as n approaches infinity of a n"],
			["x \\to 0", "x approaches 0"],
			["f: X \\to Y", "f colon X to Y"],
			["A^T", "A transpose"],
			["A^\\top", "A transpose"],
			["\\mathbb{E}[X]", "the expected value of X"],
			["\\mathbb{E}_{x \\sim p}[f(x)]", "the expected value over x distributed as p, of f of x"],
			["X \\sim \\mathcal{N}(0,1)", "X is distributed as script N of 0 comma 1"],
			["\\partial f", "partial f"],
			["\\nabla f", "the gradient of f"],
			["\\nabla_\\theta L", "the gradient with respect to theta of L"],
			["x_1, \\dots, x_n", "x 1 comma and so on comma x n"],
			["x \\in \\mathbb{R}^n", "x is in R n"],
			["\\mathbb{R}^{m \\times n}", "R m by n"],
			["\\binom{n}{k}", "n choose k"],
			["\\arg\\min_x f(x)", "the arg min over x of f of x"],
			["p(y|x)", "p of y given x"],
			["\\{1,2,3\\}", "the set 1 comma 2 comma 3"],
			["A \\succeq 0", "A is greater than or equal to 0"],
			["a ⪰ b", "a is greater than or equal to b"],
			["A \\preceq B", "A is less than or equal to B"],
		];
		for (const [latex, words] of readings) assert.equal(await speakMath(latex), words, latex);
	});
	it("fails loudly when the engine lacks an overridden rule", async () => {
		const mathmaps = path.join(path.dirname(createRequire(import.meta.url).resolve("speech-rule-engine")), "mathmaps");
		const en = fs.readFileSync(path.join(mathmaps, "en.json"), "utf8");
		const base = fs.readFileSync(path.join(mathmaps, "base.json"), "utf8");
		assert.doesNotThrow(() => patchLocale(en, base));
		// fences-open-close lives in the base rules only.
		assert.throws(() => patchLocale(en, "{}"), /fences-open-close/);
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

describe("the read-aloud language (owner, 2026-11-01)", () => {
	it("speaks cues, callout leads, arrows and question leads in German", () => {
		assert.deepEqual(speechBlocks("A → B\n\n```js\nx\n```", "de"), [[text("A, führt zu, B")], [text("Siehe den Codeblock.")]]);
		assert.deepEqual(speechBlocks("> [!IMPORTANT]\n> Merken", "de"), [[text("Kernidee: Merken")]]);
		const asked = questionSpeechBlocks("ask_user_question", "c1", { question: "Welche?", options: [{ label: "Eins" }] }, "de");
		assert.deepEqual(asked.map((b) => b.block), [[text("Und jetzt die Frage: Welche?")], [text("Option 1: Eins")]]);
		assert.deepEqual(speechBlocks("A → B"), [[text("A, leads to, B")]], "English stays the default");
	});
	it("reads formulas in German and switches back to English", async () => {
		assert.deepEqual(await Promise.all([speakMath("\\frac{a}{b} + x^2", "de"), speakMath("x^2", "en")]), ["a geteilt durch b plus x Quadrat", "x squared"]);
	});
	it("keeps a language from the settings and tells voices' languages", () => {
		assert.deepEqual(sanitizeSpeech({ language: "de" }), { language: "de" });
		assert.deepEqual(sanitizeSpeech({ language: "xx" }), {});
		assert.deepEqual(speechVoice("bf_emma"), { id: "bf_emma", language: "en" });
		assert.deepEqual(speechVoice({ id: "thorsten", language: "de-DE" }), { id: "thorsten", language: "de" });
		assert.deepEqual(speechVoice("custom"), { id: "custom", language: null });
		const all = [{ id: "af_heart", language: "en" }, { id: "thorsten", language: "de" }, { id: "custom", language: null }];
		assert.deepEqual(voicesFor(all, "de").map((v) => v.id), ["thorsten", "custom"]);
	});
});

describe("speech settings", () => {
	it("resolve to off with no URL", () => {
		assert.deepEqual(resolveSpeech(undefined), { url: null, voice: null, speed: 1, autoRead: false, language: "en" });
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
		// The owner's slider range, 0.5–3 (speed slider, 2026-10-24).
		assert.ok(parseSpeechSettingsBody({ speed: 3 }).ok);
		assert.ok(!parseSpeechSettingsBody({ speed: 0.25 }).ok);
		assert.ok(!parseSpeechSettingsBody({ speed: 3.5 }).ok);
		assert.ok(!parseSpeechSettingsBody({ autoRead: 1 }).ok);
	});
	it("the status line names host, voice and a non-default speed", () => {
		assert.equal(speechStatusLine(undefined), "not set");
		assert.equal(speechStatusLine({ url: "http://localhost:8110/v1" }), "localhost:8110 · English");
		assert.equal(speechStatusLine({ url: "http://localhost:8110/v1", voice: "af_heart", speed: 1.2, language: "de" }), "localhost:8110 · Deutsch · af_heart · 1.2×");
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
		assert.deepEqual(speechConfig(), { url: "http://tts:8110/v1", voice: "af_heart", speed: 1.25, autoRead: false, language: "en" });
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
	it("reads a formula on its own at 0.8 of the speed, never below the minimum", async () => {
		writeSettings({ version: 1, speech: { url: "http://tts:8110/v1", speed: 1.5 } });
		await synthesizeSpeech([math("x^2")], fake(200, "ID3") as typeof fetch);
		assert.equal(seen.at(-1)!.body!.speed, 1.2);
		await synthesizeSpeech([text("So "), math("x^2")], fake(200, "ID3") as typeof fetch);
		assert.equal(seen.at(-1)!.body!.speed, 1.5);
		writeSettings({ version: 1, speech: { url: "http://tts:8110/v1", speed: 0.5 } });
		await synthesizeSpeech([math("x^2")], fake(200, "ID3") as typeof fetch);
		assert.equal(seen.at(-1)!.body!.speed, 0.5);
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
		assert.deepEqual(r, { ok: true, voices: [{ id: "af_heart", language: "en" }, { id: "am_adam", language: "en" }] });
	});
});
