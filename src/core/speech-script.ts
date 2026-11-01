/**
 * THE SPOKEN SCRIPT (read-aloud wave, owner 2026-10-24): reply markdown →
 * what read-aloud says, block by block. Owner rulings:
 *
 * - Prose, headings, lists and callouts are read; emphasis and markup are
 *   dropped; links read their text.
 * - Arrows read as words between pauses: "A → B" → "A, leads to, B"
 *   (owner 2026-10-30; ⇒ "implies", ← "comes from", ↔ "corresponds to",
 *   ⇔ "if and only if", ASCII forms too, inline code included).
 * - `> [!IMPORTANT]` reads "Key idea: …" (NOTE/TIP/WARNING/CAUTION read
 *   their own label).
 * - Code, mermaid diagrams and tables are NOT read — a short cue tells the
 *   listener to look ("See the code block.").
 * - Math stays LaTeX here — a `math` segment. The server turns it into
 *   words (Speech Rule Engine, ClearSpeak — src/server/tts.ts); this
 *   module is pure and browser-safe, so it never loads that engine.
 *
 * One BLOCK = one spoken request: a paragraph, a heading, a list item's
 * paragraph, a display equation, a cue. Containers (lists, quotes) are
 * flattened to their leaf blocks, so appending text to a reply only ever
 * adds blocks after the ones already returned — the property streaming
 * auto-read relies on (closedMarkdown below hands it the stable prefix).
 */

import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { transformMathDelimiters } from "./math-delims.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";
import { normalizeOptions, seededRandom, shuffleOptions, type QuizOption } from "./question-core.ts";
import type { SpeechLanguage } from "./speech.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";

export type SpeechSegment = { kind: "text"; text: string } | { kind: "math"; latex: string };

/** One spoken request's worth of content. */
export type SpeechBlock = SpeechSegment[];

/** Everything this module says in its own words, per read-aloud language
 *  (owner, 2026-11-01): the look-cues, callout leads, question leads and
 *  arrow words. */
interface SpeechWords {
	cues: { code: string; diagram: string; table: string };
	/** GitHub alert labels → the spoken lead-in. */
	callouts: Record<string, string>;
	question: string;
	option: (n: number) => string;
	arrows: { corresponds: string; iff: string; leads: string; implies: string; comes: string };
}

const WORDS: Record<SpeechLanguage, SpeechWords> = {
	en: {
		cues: { code: "See the code block.", diagram: "See the diagram.", table: "See the table." },
		callouts: { IMPORTANT: "Key idea:", NOTE: "Note:", TIP: "Tip:", WARNING: "Warning:", CAUTION: "Caution:" },
		question: "And now the question:",
		option: (n) => `Option ${n}:`,
		arrows: { corresponds: "corresponds to", iff: "if and only if", leads: "leads to", implies: "implies", comes: "comes from" },
	},
	de: {
		cues: { code: "Siehe den Codeblock.", diagram: "Siehe das Diagramm.", table: "Siehe die Tabelle." },
		callouts: { IMPORTANT: "Kernidee:", NOTE: "Hinweis:", TIP: "Tipp:", WARNING: "Warnung:", CAUTION: "Vorsicht:" },
		question: "Und jetzt die Frage:",
		option: (n) => `Option ${n}:`,
		arrows: { corresponds: "entspricht", iff: "genau dann, wenn", leads: "führt zu", implies: "daraus folgt", comes: "kommt von" },
	},
};

export const SPEECH_CUES = WORDS.en.cues;

/** The words of the call in progress. The module's entry points set them
 *  for their synchronous parse and restore them after — no await in
 *  between, so no other call can see them. */
let words: SpeechWords = WORDS.en;

function inLanguage<T>(language: SpeechLanguage, fn: () => T): T {
	const previous = words;
	words = WORDS[language];
	try {
		return fn();
	} finally {
		words = previous;
	}
}

const CALLOUT_MARK_RE = /^\s*\[!([A-Za-z]+)\][ \t]*\n?/;

/** Reply markdown → its spoken blocks, in reading order, in `language`'s words. */
export function speechBlocks(markdown: string, language: SpeechLanguage = "en"): SpeechBlock[] {
	return inLanguage(language, () => blocksOf(markdown));
}

function blocksOf(markdown: string): SpeechBlock[] {
	const tree = fromMarkdown(transformMathDelimiters(markdown), {
		extensions: [gfm(), math()],
		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
	});
	const blocks: SpeechBlock[] = [];
	for (const node of tree.children) collectBlocks(node, blocks);
	return blocks.map(tidyBlock).filter((block) => block.length > 0);
}

/** One turn of an assistant view message (per-turn read-aloud, owner
 *  2026-10-27). A view message is a GROUP that keeps running across dock
 *  answers (an answer is a toolResult, not a user message), so a group
 *  can hold several turns: each ends at an answered question. */
export interface ReplyTurn {
	/** `${message id}:${index}` — the read-aloud owner; stable as turns append. */
	key: string;
	/** The turn's parts: `parts.slice(start, end)` of its message. */
	start: number;
	end: number;
	/** The turn's prose, its text parts joined. */
	text: string;
}

function isAnsweredQuestion(part: LhViewPart): boolean {
	return (
		part.type.startsWith("tool-") &&
		(QUESTION_TOOLS as readonly string[]).includes(part.type.slice("tool-".length)) &&
		part.state === "output-available"
	);
}

/** A message's turns, split after each answered question. An unanswered
 *  question stays inside its turn; a message always has at least one. */
export function replyTurns(message: LhViewMessage): ReplyTurn[] {
	const turns: ReplyTurn[] = [];
	let start = 0;
	const close = (end: number) => {
		const text = message.parts
			.slice(start, end)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n\n");
		turns.push({ key: `${message.id}:${turns.length}`, start, end, text });
		start = end;
	};
	message.parts.forEach((part, i) => {
		if (isAnsweredQuestion(part)) close(i + 1);
	});
	if (start < message.parts.length || turns.length === 0) close(message.parts.length);
	return turns;
}

/** A block whose segments start with a lead-in ("Option 1:", "Key idea:"). */
export function withLead(lead: string, blocks: SpeechBlock[]): SpeechBlock[] {
	const [first, ...rest] = blocks;
	if (!first) return [[{ kind: "text", text: lead }]];
	return [tidyBlock([{ kind: "text", text: `${lead} ` }, ...first]), ...rest];
}

/** The silence before a spoken block (owner 2026-10-30): after every
 *  paragraph, longer before a dock question, between its options. */
export type SpeechPause = "paragraph" | "question" | "option";

/** The pause lengths at speed 1; the player divides them by the speed. */
export const SPEECH_PAUSE_MS: Record<SpeechPause, number> = { paragraph: 700, question: 1200, option: 900 };

/** A block with the pause the player keeps before it. */
export interface SpokenBlock {
	block: SpeechBlock;
	pauseBefore: SpeechPause;
}

/** Blocks with a pause: `first` before the first, a paragraph pause between the rest. */
function spoken(blocks: SpeechBlock[], first: SpeechPause): SpokenBlock[] {
	return blocks.map((block, i) => ({ block, pauseBefore: i === 0 ? first : "paragraph" }));
}

/**
 * A question-dock question, spoken (owner ruling: question, context, then
 * every option — "Option 1: …" in the dock's display order, so quiz
 * options get the dock's same seeded shuffle). Option descriptions are
 * read where the dock shows them (never on quizzes); the dock's built-in
 * "I don't know" is not read. A question with options opens on "And now
 * the question:" (owner 2026-10-30); every question is set apart by the
 * longer pause, every option by its own.
 */
export function questionSpeechBlocks(tool: string, toolCallId: string, input: unknown, language: SpeechLanguage = "en"): SpokenBlock[] {
	return inLanguage(language, () => questionBlocks(tool, toolCallId, input));
}

function questionBlocks(tool: string, toolCallId: string, input: unknown): SpokenBlock[] {
	const raw = (input ?? {}) as { question?: unknown; details?: unknown; options?: unknown };
	const kind = toolQuestionKind(tool);
	const asked: SpeechBlock[] = [];
	if (typeof raw.question === "string") asked.push(...blocksOf(raw.question));
	if (typeof raw.details === "string") asked.push(...blocksOf(raw.details));
	if (kind === "explain") return spoken(asked, "question");
	const blocks = spoken(withLead(words.question, asked), "question");
	let options: QuizOption[] = [];
	try {
		options = normalizeOptions(raw.options as Parameters<typeof normalizeOptions>[0]);
	} catch {
		// Duplicate option values: the dock refuses them too.
	}
	if (kind === "quiz") options = shuffleOptions(options, seededRandom(toolCallId));
	options.forEach((option, i) => {
		const said = blocksOf(option.label);
		if (kind !== "quiz" && option.description) said.push(...blocksOf(option.description));
		blocks.push(...spoken(withLead(words.option(i + 1), said), "option"));
	});
	return blocks;
}

function collectBlocks(node: RootContent, out: SpeechBlock[]): void {
	switch (node.type) {
		case "paragraph":
			out.push(phrasing(node.children));
			return;
		case "heading":
			out.push(endSentence(phrasing(node.children)));
			return;
		case "math":
			out.push([{ kind: "math", latex: node.value }]);
			return;
		case "code":
			out.push([{ kind: "text", text: node.lang?.toLowerCase() === "mermaid" ? words.cues.diagram : words.cues.code }]);
			return;
		case "table":
			out.push([{ kind: "text", text: words.cues.table }]);
			return;
		case "list":
		case "listItem":
			for (const child of node.children) collectBlocks(child, out);
			return;
		case "blockquote": {
			const start = out.length;
			for (const child of node.children) collectBlocks(child, out);
			applyCallout(out, start);
			return;
		}
		default:
			// thematicBreak, html, definitions, footnotes: nothing to say.
			return;
	}
}

/** A quote that opens with `[!LABEL]` is a callout: the marker becomes the
 *  spoken lead-in of its first block. */
function applyCallout(out: SpeechBlock[], start: number): void {
	const block = out[start];
	const first = block?.[0];
	if (!block || first?.kind !== "text") return;
	const mark = CALLOUT_MARK_RE.exec(first.text);
	if (!mark) return;
	const lead = words.callouts[(mark[1] ?? "").toUpperCase()];
	const rest = first.text.slice(mark[0].length);
	out[start] = [{ kind: "text", text: lead ? `${lead} ${rest}` : rest }, ...block.slice(1)];
}

function phrasing(children: PhrasingContent[]): SpeechBlock {
	const out: SpeechBlock = [];
	for (const child of children) inline(child, out);
	return out;
}

function inline(node: Nodes, out: SpeechBlock): void {
	switch (node.type) {
		case "text":
		case "inlineCode":
			out.push({ kind: "text", text: node.value });
			return;
		case "inlineMath":
			out.push({ kind: "math", latex: node.value });
			return;
		case "break":
			out.push({ kind: "text", text: " " });
			return;
		case "image":
			if (node.alt) out.push({ kind: "text", text: node.alt });
			return;
		case "emphasis":
		case "strong":
		case "delete":
		case "link":
		case "linkReference":
			for (const child of node.children) inline(child, out);
			return;
		default:
			// html, footnote references: not spoken.
			return;
	}
}

/** Headings end with a period so the voice pauses after them. */
function endSentence(block: SpeechBlock): SpeechBlock {
	const last = block.at(-1);
	if (last?.kind === "text" && !/[.!?:]\s*$/.test(last.text)) {
		return [...block.slice(0, -1), { kind: "text", text: `${last.text.trimEnd()}.` }];
	}
	if (last?.kind === "math") return [...block, { kind: "text", text: "." }];
	return block;
}

/** Arrow → its spoken word (owner 2026-10-30). */
const ARROW_WORDS: Record<string, keyof SpeechWords["arrows"]> = {
	"<->": "corresponds",
	"↔": "corresponds",
	"⇔": "iff",
	"-->": "leads",
	"->": "leads",
	"→": "leads",
	"=>": "implies",
	"⇒": "implies",
	"<-": "comes",
	"←": "comes",
};

const ARROW_RE = /\s*(<->|-->|->|=>|<-|[↔⇔→⇒←])\s*/g;

/** Arrows read as words, set apart by commas — the voice pauses on them:
 *  "A → B" → "A, leads to, B". */
function speakArrows(text: string): string {
	return text.replace(ARROW_RE, (_, arrow: string) => `, ${words.arrows[ARROW_WORDS[arrow]!]}, `);
}

/** Merge adjacent text, read arrows, collapse whitespace, drop empties. */
function tidyBlock(block: SpeechBlock): SpeechBlock {
	const out: SpeechBlock = [];
	for (const segment of block) {
		if (segment.kind === "math") {
			if (segment.latex.trim()) out.push({ kind: "math", latex: segment.latex.trim() });
			continue;
		}
		const prev = out.at(-1);
		if (prev?.kind === "text") prev.text += segment.text;
		else out.push({ kind: "text", text: segment.text });
	}
	return out
		.map((segment) =>
			segment.kind === "text" ? { kind: "text" as const, text: speakArrows(segment.text).replace(/\s+/g, " ") } : segment,
		)
		.filter((segment) => segment.kind === "math" || segment.text.trim() !== "")
		.map((segment, i, all) => {
			if (segment.kind !== "text") return segment;
			let text = segment.text;
			// A block that opens on an arrow has no pause before its word.
			if (i === 0) text = text.trimStart().replace(/^, /, "");
			if (i === all.length - 1) text = text.trimEnd();
			return { kind: "text" as const, text };
		});
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The prefix of a STREAMING reply whose blocks are final: everything up to
 * the last blank line that sits outside a code fence and outside `$$`
 * display math. Blocks after it may still grow, so they are not spoken yet.
 */
export function closedMarkdown(partial: string): string {
	// The last line has no newline after it yet — it can still grow.
	const lines = partial.split("\n").slice(0, -1);
	let fence: string | null = null;
	let inMath = false;
	let offset = 0;
	let cut = 0;
	for (const line of lines) {
		const marker = FENCE_RE.exec(line)?.[1];
		const trimmed = line.trim();
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) fence = null;
		} else if (inMath) {
			if (trimmed.endsWith("$$")) inMath = false;
		} else if (marker) {
			fence = marker;
		} else if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$")) {
			inMath = true;
		} else if (trimmed === "") {
			cut = offset;
		}
		offset += line.length + 1;
	}
	return partial.slice(0, cut);
}
