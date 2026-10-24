/**
 * THE SPOKEN SCRIPT (read-aloud wave, owner 2026-10-24): reply markdown →
 * what read-aloud says, block by block. Owner rulings:
 *
 * - Prose, headings, lists and callouts are read; emphasis and markup are
 *   dropped; links read their text.
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
import { toolQuestionKind } from "./pending.ts";
import { normalizeOptions, seededRandom, shuffleOptions, type QuizOption } from "./question-core.ts";

export type SpeechSegment = { kind: "text"; text: string } | { kind: "math"; latex: string };

/** One spoken request's worth of content. */
export type SpeechBlock = SpeechSegment[];

export const SPEECH_CUES = {
	code: "See the code block.",
	diagram: "See the diagram.",
	table: "See the table.",
} as const;

/** GitHub alert labels → the spoken lead-in. */
const CALLOUT_LEADS: Record<string, string> = {
	IMPORTANT: "Key idea:",
	NOTE: "Note:",
	TIP: "Tip:",
	WARNING: "Warning:",
	CAUTION: "Caution:",
};

const CALLOUT_MARK_RE = /^\s*\[!([A-Za-z]+)\][ \t]*\n?/;

/** Reply markdown → its spoken blocks, in reading order. */
export function speechBlocks(markdown: string): SpeechBlock[] {
	const tree = fromMarkdown(transformMathDelimiters(markdown), {
		extensions: [gfm(), math()],
		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
	});
	const blocks: SpeechBlock[] = [];
	for (const node of tree.children) collectBlocks(node, blocks);
	return blocks.map(tidyBlock).filter((block) => block.length > 0);
}

/** A block whose segments start with a lead-in ("Option 1:", "Key idea:"). */
export function withLead(lead: string, blocks: SpeechBlock[]): SpeechBlock[] {
	const [first, ...rest] = blocks;
	if (!first) return [[{ kind: "text", text: lead }]];
	return [tidyBlock([{ kind: "text", text: `${lead} ` }, ...first]), ...rest];
}

/**
 * A question-dock question, spoken (owner ruling: question, context, then
 * every option — "Option 1: …" in the dock's display order, so quiz
 * options get the dock's same seeded shuffle). Option descriptions are
 * read where the dock shows them (never on quizzes); the dock's built-in
 * "I don't know" is not read.
 */
export function questionSpeechBlocks(tool: string, toolCallId: string, input: unknown): SpeechBlock[] {
	const raw = (input ?? {}) as { question?: unknown; details?: unknown; options?: unknown };
	const kind = toolQuestionKind(tool);
	const blocks: SpeechBlock[] = [];
	if (typeof raw.question === "string") blocks.push(...speechBlocks(raw.question));
	if (typeof raw.details === "string") blocks.push(...speechBlocks(raw.details));
	if (kind === "explain") return blocks;
	let options: QuizOption[] = [];
	try {
		options = normalizeOptions(raw.options as Parameters<typeof normalizeOptions>[0]);
	} catch {
		// Duplicate option values: the dock refuses them too.
	}
	if (kind === "quiz") options = shuffleOptions(options, seededRandom(toolCallId));
	options.forEach((option, i) => {
		const said = speechBlocks(option.label);
		if (kind !== "quiz" && option.description) said.push(...speechBlocks(option.description));
		blocks.push(...withLead(`Option ${i + 1}:`, said));
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
			out.push([{ kind: "text", text: node.lang?.toLowerCase() === "mermaid" ? SPEECH_CUES.diagram : SPEECH_CUES.code }]);
			return;
		case "table":
			out.push([{ kind: "text", text: SPEECH_CUES.table }]);
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
	const lead = CALLOUT_LEADS[(mark[1] ?? "").toUpperCase()];
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

/** Merge adjacent text, collapse whitespace, drop empties. */
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
		.map((segment) => (segment.kind === "text" ? { kind: "text" as const, text: segment.text.replace(/\s+/g, " ") } : segment))
		.filter((segment) => segment.kind === "math" || segment.text.trim() !== "")
		.map((segment, i, all) => {
			if (segment.kind !== "text") return segment;
			let text = segment.text;
			if (i === 0) text = text.trimStart();
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
