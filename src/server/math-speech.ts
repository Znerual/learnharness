/**
 * READ-ALOUD MATH (math-speech wave, owner 2026-10-24): one LaTeX formula
 * → the words the voice reads. Deterministic and offline: KaTeX renders
 * MathML, Speech Rule Engine (the MathJax accessibility engine) reads it
 * in its ClearSpeak style. English only, like the Kokoro voices.
 *
 * ClearSpeak's stock wording is stiff for the formulas a teacher writes
 * ("m sub t", "open paren … close paren", "the fraction with numerator").
 * The owner's readings are layered on in three steps:
 * 1. MathML cleanup before the engine (upright letters, \mathrm words).
 * 2. Patched ClearSpeak rules: the engine's `custom` locale loader hands
 *    it its own rule files with our overrides applied — rule actions
 *    replaced, rules and symbol names added. A comma in an action is a
 *    spoken pause (the voice pauses on commas), marking where a group
 *    ends: "m_{t-1} + 1" → "m t minus 1, plus 1".
 * 3. Text cleanup: no trailing pause, no doubled commas.
 *
 * The overrides name rules of speech-rule-engine 4.1.4; a name the engine
 * no longer has throws at setup, so an upgrade fails in tests, not
 * silently in speech.
 */

import { readFile } from "node:fs/promises";
import katex from "katex";

/** Spoken when KaTeX cannot parse a formula. */
const UNREADABLE_MATH = "a formula";

/** ClearSpeak preferences: "a times b", "natural log", "y given x", "x is in", "n choose k". */
const CLEARSPEAK_STYLE = [
	"ImpliedTimes_MoreImpliedTimes",
	"Log_LnAsNaturalLog",
	"VerticalLine_Given",
	"SetMemberSymbol_In",
	"Matrix_Combinatoric",
].join(":");

// ─── rule overrides ──────────────────────────────────────────────────────────

const COMPOUND_EXPONENT = '[n] children/*[1]; [t] "to the"; [n] children/*[2]; [t] ","';

/** Existing ClearSpeak rule → its new action. */
const ACTION_OVERRIDES: Record<string, string> = {
	// A group's end is a pause, its start a word: "parenthesis a plus b, times c".
	"fences-open-close": '[t] "parenthesis"; [n] children/*[1]; [t] ","',
	"paren-simple-nested-func-default": '[n] children/*[1]; [t] ","',
	"fences-metric": '[t] "the norm of"; [n] children/*[1]; [t] ","',
	// Compound subscripts and exponents end on a pause; simple ones are rules below.
	subscript: '[n] children/*[1]; [n] children/*[2]; [t] ","',
	superscript: COMPOUND_EXPONENT,
	fraction: '[t] "fraction"; [n] children/*[1]; [t] ", over"; [n] children/*[2]; [t] ","',
};

/** A rule added to ClearSpeak: its name, style, XPath constraints on the semantic tree, and action. */
interface AddedRule {
	name: string;
	style?: string;
	when: string[];
	action: string;
}

/** The engine prefers the rule with more constraints; no-op ones lift a rule over the stock ones. */
const OUTRANK = ["self::*", "self::*", "self::*", "self::*"];

const ADDED_RULES: AddedRule[] = [
	{
		name: "subscript-simple",
		when: ["self::subscript", 'name(children/*[2])="identifier" or name(children/*[2])="number"'],
		action: "[n] children/*[1]; [n] children/*[2]",
	},
	{
		name: "fences-bracket",
		when: ["self::fenced", '@role="leftright"', 'content/*[1][text()="["]'],
		action: '[t] "bracket"; [n] children/*[1]; [t] ","',
	},
	{
		name: "fences-brace",
		when: ["self::fenced", '@role="leftright"', 'content/*[1][text()="{"]'],
		action: '[t] "brace"; [n] children/*[1]; [t] ","',
	},
	// A function's argument: "of" already opens the group — "max of a comma b,".
	{
		name: "fences-function-argument",
		when: ["self::fenced", '@role="leftright"', 'name(..)="children"', 'name(../..)="appl"', "preceding-sibling::*"],
		action: '[n] children/*[1]; [t] ","',
	},
	// A number coefficient takes no "times": "2 x", "3 a times b" — but "2 times parenthesis …".
	{
		name: "implicit-times-coefficient",
		style: "ImpliedTimes_MoreImpliedTimes",
		when: [
			"self::operator",
			'@role="multiplication"',
			'text()="\u2062"',
			"not(preceding-sibling::*)",
			'name(../../children/*[1])="number"',
			'name(../../children/*[2])!="fenced"',
		],
		action: "",
	},
	// Letters side by side in a subscript are an index, not a product: x_{ij} → "x i j,".
	{
		name: "implicit-times-index",
		style: "ImpliedTimes_MoreImpliedTimes",
		when: [
			"self::operator",
			'@role="multiplication"',
			'text()="\u2062"',
			'name(../../../..)="subscript"',
			"../../preceding-sibling::*",
		],
		action: "",
	},
	// A differential: dx, dy → "d x".
	{
		name: "implicit-times-differential",
		style: "ImpliedTimes_MoreImpliedTimes",
		when: [
			"self::operator",
			'@role="multiplication"',
			'text()="\u2062"',
			"count(../../children/*)=2",
			'../../children/*[1][text()="d"]',
		],
		action: "",
	},
	// e^{-x^2} → "e to the negative x squared,"; x^2, x^n, x^{-1}, x' and sin^2 keep the stock words.
	{
		name: "superscript-compound",
		when: [
			"self::superscript",
			'name(children/*[2])!="identifier" and name(children/*[2])!="number"',
			'not(name(children/*[2])="prefixop" and name(children/*[2]/children/*[1])="number")',
			'children/*[2][@role!="prime"]',
			'children/*[1][@role!="simple function" and @role!="prefix function" and @role!="numbersetletter"]',
			'name(children/*[2])!="operator"',
			...OUTRANK,
		],
		action: COMPOUND_EXPONENT,
	},
	// x → 0, n → ∞ and every limit: "approaches"; other arrows say "to".
	{
		name: "arrow-approaches",
		when: [
			"self::relation",
			'text()="\u2192"',
			'ancestor::limlower or name(../../children/*[2])="number" or ../../children/*[2][@role="infty"]',
		],
		action: '[t] "approaches"',
	},
	// \mathbb{R}^n → "R n"; \mathbb{R}^{m \times n} → "R m by n".
	{
		name: "real-space",
		when: ["self::superscript", 'children/*[1][@role="numbersetletter" and (text()="R" or text()="\u211d")]', ...OUTRANK],
		action: '[t] "R"; [n] children/*[2]',
	},
	{
		name: "real-space-by",
		when: [
			"self::operator",
			'text()="\u00d7"',
			'ancestor::superscript[children/*[1][@role="numbersetletter" and (text()="R" or text()="\u211d")]]',
		],
		action: '[t] "by"',
	},
	// \nabla_\theta L → "the gradient with respect to theta of L".
	{
		name: "gradient-with-respect-to",
		when: ["self::prefixop", 'name(content/*[1])="subscript"', 'content/*[1]/children/*[1][text()="\u2207"]'],
		action: '[t] "the gradient with respect to"; [n] content/*[1]/children/*[2]; [t] "of"; [n] children/*[1]',
	},
	// \arg\min_x f(x) → "the arg min over x of f of x".
	{
		name: "arg-min-max",
		when: ["self::appl", 'content/*[2][text()="arg"]', 'name(children/*[2])="appl"', ...OUTRANK],
		action: '[t] "the arg"; [n] children/*[2]',
	},
	{
		name: "transpose",
		when: ["self::superscript", 'children/*[2][text()="T" or text()="\u22a4"]', ...OUTRANK],
		action: '[n] children/*[1]; [t] "transpose"',
	},
	{
		name: "limit-lower",
		when: ["self::limlower", 'children/*[1][text()="lim"]'],
		action: '[t] "the limit as"; [n] children/*[2]',
	},
	// \mathbb{E}_{x \sim p}[f(x)] → "the expected value over x distributed as p, of f of x".
	{
		name: "expected-value-over",
		when: [
			"self::appl",
			'name(children/*[1])="subscript"',
			'children/*[1]/children/*[1][text()="E" and @font="double-struck"]',
			...OUTRANK,
		],
		action: '[t] "the expected value over"; [n] children/*[1]/children/*[2]; [t] ", of"; [n] children/*[2]',
	},
	{
		name: "distributed-as-under-expected-value",
		when: [
			"self::relation",
			'text()="\u223c"',
			'ancestor::subscript[children/*[1][text()="E" and @font="double-struck"]]',
		],
		action: '[t] "distributed as"',
	},
	{
		name: "expected-value",
		when: ["self::appl", 'children/*[1][text()="E" and @font="double-struck"]'],
		action: '[t] "the expected value of"; [n] children/*[2]',
	},
	{
		name: "vector-accent",
		when: ["self::overscore", 'children/*[2][text()="\u20d7"]', ...OUTRANK],
		action: '[t] "vector"; [n] children/*[1]',
	},
	{
		name: "natural-log-of",
		style: "Log_LnAsNaturalLog",
		when: ["self::appl", '@role="prefix function"', 'content/*[2][text()="ln"]', 'contains(@grammar, "NatLog")'],
		action: '[n] children/*[1]; [t] "of"; [n] children/*[2]',
	},
];

/** Symbol (hex code point, as the engine keys it) → its ClearSpeak name. */
const SYMBOL_OVERRIDES: Record<string, string> = {
	"2192": "to", // f: X → Y; a limit's arrow is a rule
	"223C": "is distributed as", // X ~ N(0, 1)
	"2026": "and so on", // x_1, …, x_n
	"22EF": "and so on",
	"221E": "infinity",
	"2AB0": "is greater than or equal to", // A ⪰ 0, read like ≥
	"2AAF": "is less than or equal to", // A ⪯ B, read like ≤
};

/** Symbols the engine has no name for (KaTeX accents). */
const SYMBOL_ADDITIONS: Record<string, string> = {
	"02C9": "bar", // \bar x
};

/** Greek-alphabet names (the engine generates ∂ and ∇ from this list). */
const LETTER_OVERRIDES: Record<string, string> = {
	"partial differential": "partial",
	nabla: "the gradient of",
};

// Everything goes into the English rule files: the engine may load its
// shared `base` locale before our loader is in place, `en` always after.
const RULES_FILE = "en/rules/clearspeak_english.min";
const ACTIONS_FILE = "en/rules/clearspeak_english_actions.min";
const SYMBOLS_FILE = "en/symbols/math_symbols.min";
const ALPHABETS_FILE = "en/messages/alphabets.min";

type RuleSet = { rules: unknown[][] };
type SymbolEntry = { key?: string; mappings?: Record<string, Record<string, string>> };

/** Every rule name in the engine's ClearSpeak sets of one locale file. */
function clearspeakRuleNames(maps: Record<string, unknown>): Set<string> {
	const names = new Set<string>();
	for (const [file, set] of Object.entries(maps)) {
		if (file.includes("/rules/clearspeak")) for (const rule of (set as RuleSet).rules) names.add(rule[1] as string);
	}
	return names;
}

/**
 * The engine's `en` locale file (JSON) with the overrides applied. `base`
 * is the shared locale file, read only to check that every overridden
 * rule still exists — an engine upgrade that renames one throws here.
 */
export function patchLocale(enJson: string, baseJson: string): string {
	const maps = JSON.parse(enJson) as Record<string, unknown>;
	const known = new Set([...clearspeakRuleNames(maps), ...clearspeakRuleNames(JSON.parse(baseJson) as Record<string, unknown>)]);
	const missing = Object.keys(ACTION_OVERRIDES).filter((name) => !known.has(name));

	const rules = maps[RULES_FILE] as RuleSet;
	const actions = maps[ACTIONS_FILE] as RuleSet;
	for (const { name, style = "default", when, action } of ADDED_RULES) {
		rules.rules.push(["Precondition", name, style, ...when]);
		actions.rules.push(["Action", name, action]);
	}
	// An action of the same name in the English set wins over the base one.
	for (const [name, action] of Object.entries(ACTION_OVERRIDES)) actions.rules.push(["Action", name, action]);

	const renamed = new Set<string>();
	for (const entry of Object.values(maps).filter(Array.isArray).flat() as SymbolEntry[]) {
		const name = entry.key === undefined ? undefined : SYMBOL_OVERRIDES[entry.key];
		if (name !== undefined && entry.key && entry.mappings) {
			entry.mappings.clearspeak = { default: name };
			renamed.add(entry.key);
		}
	}
	missing.push(...Object.keys(SYMBOL_OVERRIDES).filter((key) => !renamed.has(key)));
	const symbols = maps[SYMBOLS_FILE] as SymbolEntry[];
	for (const [key, name] of Object.entries(SYMBOL_ADDITIONS)) symbols.push({ key, mappings: { default: { default: name } } });

	const greek = (maps[ALPHABETS_FILE] as { messages: { greekSmall: string[] } }).messages.greekSmall;
	missing.push(...Object.keys(LETTER_OVERRIDES).filter((name) => !greek.includes(name)));
	for (const [i, name] of greek.entries()) greek[i] = LETTER_OVERRIDES[name] ?? name;

	if (missing.length) throw new Error(`speech-rule-engine lacks overridden rules or symbols: ${missing.join(", ")}`);
	return JSON.stringify(maps);
}

// ─── the engine ──────────────────────────────────────────────────────────────

type Sre = typeof import("speech-rule-engine").default;
let sreReady: Promise<Sre> | null = null;

/** Speech Rule Engine, set up once per process (it is a global singleton). */
function mathEngine(): Promise<Sre> {
	sreReady ??= (async () => {
		// A CommonJS package: plain Node hands the exports over as `default`,
		// tsx's loader spreads them onto the namespace instead.
		const mod = (await import("speech-rule-engine")) as { default?: Sre } & Partial<Sre>;
		const sre = mod.default ?? (mod as Sre);
		await sre.setupEngine({
			locale: "en",
			domain: "clearspeak",
			modality: "speech",
			style: CLEARSPEAK_STYLE,
			// The engine's own rule files, found the way the engine finds them.
			custom: async (locale: string) => {
				const json = await readFile(sre.localePath(locale), "utf8");
				return locale === "en" ? patchLocale(json, await readFile(sre.localePath("base"), "utf8")) : json;
			},
		});
		await sre.engineReady();
		return sre;
	})().catch((error: unknown) => {
		sreReady = null;
		throw error;
	});
	return sreReady;
}

// ─── formula → words ─────────────────────────────────────────────────────────

const UPRIGHT_LETTER = /<mi mathvariant="normal">([A-Za-z])<\/mi>/g;

/** KaTeX's MathML, tidied for the engine. */
function cleanMathml(mathml: string): string {
	return (
		mathml
			.replace(/<annotation[\s\S]*?<\/annotation>/g, "")
			// \mathrm{ReLU}: KaTeX spells a word one upright letter at a time;
			// as one <mi> applied to "(" the engine reads "ReLU of x".
			.replace(/(?:<mi mathvariant="normal">[A-Za-z]<\/mi>){2,}/g, (run) => {
				const word = run.replace(UPRIGHT_LETTER, "$1");
				return `<mi>${word}</mi>`;
			})
			.replace(/(<mi>[A-Za-z]{2,}<\/mi>)(?=<mo[^>]*>\(<\/mo>)/g, "$1<mo>\u2061</mo>")
			// Upright single symbols (∞, ⊤, \mathrm{d}) would be read "normal …".
			.replace(/<mi mathvariant="normal">([^<]{1,2})<\/mi>/g, "<mi>$1</mi>")
	);
}

/** The engine's words, tidied: single spaces, no space before a comma, no pause at the end. */
function cleanWords(words: string): string {
	return words
		.replace(/\s+/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/,(\s*,)+/g, ",")
		.replace(/[\s,]+$/, "")
		.trim();
}

/** One formula, read in words. */
export async function speakMath(latex: string): Promise<string> {
	const html = katex.renderToString(latex, { output: "mathml", throwOnError: false });
	const mathml = /<math[\s\S]*<\/math>/.exec(html)?.[0];
	// KaTeX renders a parse error as a red span, without <math>.
	if (!mathml || html.includes("katex-error")) return UNREADABLE_MATH;
	const sre = await mathEngine();
	return cleanWords(sre.toSpeech(cleanMathml(mathml))) || UNREADABLE_MATH;
}
