"use client";
/**
 * READ-ALOUD (read-aloud wave, owner 2026-10-24): the renderer half. One
 * player per window — a queue of spoken blocks (core/speech-script.ts),
 * each fetched as audio from /api/tts/speak (the server turns math into
 * words and forwards to the configured /audio/speech endpoint) and played
 * in order, the next block fetched while the current one plays.
 *
 * Owner rulings:
 * - Two triggers: the per-reply speaker button (any reply, on demand) and
 *   AUTO-READ (the composer toggle, ⌘⇧S, persisted globally in the
 *   `speech` settings section) — every LIVE reply is spoken block by block
 *   while it streams; reopened history is never read by itself.
 * - Auto-read also reads the question dock's question, context and
 *   options, after the prose; a check behind the reveal is read when the
 *   learner reveals it.
 * - Playback stops on Esc (after dictation in the chain), when dictation
 *   starts, when the learner sends, and when another reply is played.
 *
 * Module-level state, the dictation flag's pattern: the Esc chain and the
 * dictation start need synchronous answers, and the buttons live in
 * unrelated subtrees.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import {
	closedMarkdown,
	isSpeechSpeed,
	speechBlocks,
	SPEECH_SPEED_MAX,
	SPEECH_SPEED_MIN,
	SPEECH_SPEED_STEP,
	type LhViewMessage,
	type SpeechBlock,
	type SpeechSettings,
	type UserSettings,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";

// ─── state ───────────────────────────────────────────────────────────────────

export interface ReadAloudState {
	/** Whose speech is queued or playing (a message id), null when silent. */
	owner: string | null;
	/** The last failure, shown on the composer toggle until the next click. */
	error: string | null;
	/** A text-to-speech URL is configured. */
	ready: boolean;
	autoRead: boolean;
	/** The synthesis speed (`speech.speed`), shown and set by the composer slider. */
	speed: number;
}

let state: ReadAloudState = { owner: null, error: null, ready: false, autoRead: false, speed: 1 };
const listeners = new Set<() => void>();

function set(patch: Partial<ReadAloudState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// ─── the player ──────────────────────────────────────────────────────────────

interface Entry {
	block: SpeechBlock;
	/** The block's audio as an object URL, fetched on first need. */
	audio?: Promise<string>;
}

let queue: Entry[] = [];
/** Bumped by stop(): every await in flight checks it and bows out. */
let generation = 0;
let pumpingGeneration = -1;
let controller = new AbortController();
let endCurrent: (() => void) | null = null;
/** Owners the learner silenced: later blocks of the same reply stay quiet. */
const muted = new Set<string>();

async function fetchAudio(block: SpeechBlock, signal: AbortSignal): Promise<string> {
	const res = await fetch("/api/tts/speak", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ segments: block }),
		signal,
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(body.message ?? `Read-aloud failed (${res.status})`);
	}
	return URL.createObjectURL(await res.blob());
}

function load(entry: Entry): Promise<string> {
	entry.audio ??= fetchAudio(entry.block, controller.signal);
	return entry.audio;
}

function playUrl(url: string): Promise<void> {
	return new Promise((resolve) => {
		const audio = new Audio(url);
		const done = () => {
			audio.onended = null;
			audio.onerror = null;
			endCurrent = null;
			URL.revokeObjectURL(url);
			resolve();
		};
		endCurrent = () => {
			audio.pause();
			done();
		};
		audio.onended = done;
		audio.onerror = done;
		audio.play().catch(done);
	});
}

async function pump(): Promise<void> {
	const gen = generation;
	if (pumpingGeneration === gen) return;
	pumpingGeneration = gen;
	try {
		while (gen === generation) {
			const entry = queue.shift();
			if (!entry) break;
			const url = await load(entry);
			if (gen !== generation) {
				URL.revokeObjectURL(url);
				break;
			}
			const next = queue[0];
			if (next) void load(next).catch(() => {});
			await playUrl(url);
		}
	} catch (error) {
		if (gen === generation) {
			stopReadAloud();
			set({ error: error instanceof Error ? error.message : "Read-aloud failed" });
		}
	} finally {
		if (pumpingGeneration === gen) pumpingGeneration = -1;
		if (gen === generation) {
			if (queue.length) void pump();
			else set({ owner: null });
		}
	}
}

/** Stop everything: the playing block, the queue, the fetches. The reply
 *  that was speaking stays muted for the rest of its stream. */
export function stopReadAloud(): void {
	generation += 1;
	controller.abort();
	controller = new AbortController();
	for (const entry of queue) entry.audio?.then(URL.revokeObjectURL, () => {});
	queue = [];
	endCurrent?.();
	if (state.owner) muted.add(state.owner);
	pendingQuestions.clear();
	if (state.owner !== null) set({ owner: null });
}

/** Is anything queued or playing? The Esc chain's synchronous question. */
export function isReadAloudActive(): boolean {
	return state.owner !== null;
}

/** Play one reply from its start, replacing whatever was playing. */
export function speakReply(owner: string, blocks: SpeechBlock[]): void {
	stopReadAloud();
	muted.delete(owner);
	if (blocks.length === 0) return;
	queue.push(...blocks.map((block) => ({ block })));
	set({ owner, error: null });
	void pump();
}

/** Queue more of a reply (auto-read). A different reply's speech stops;
 *  a reply the learner silenced stays silent. */
function appendReply(owner: string, blocks: SpeechBlock[]): void {
	if (blocks.length === 0 || muted.has(owner)) return;
	if (state.owner !== null && state.owner !== owner) stopReadAloud();
	queue.push(...blocks.map((block) => ({ block })));
	if (state.owner !== owner) set({ owner, error: null });
	void pump();
}

// ─── questions (auto-read) ───────────────────────────────────────────────────

/** Question calls that arrived live, with the reply they belong to. The
 *  auto-read hook marks a call AFTER the prose before it is queued; the
 *  dock offers its question when it is shown. Either may come first —
 *  whichever is second queues the question, so it always follows the
 *  prose. */
const liveQuestions = new Map<string, string>();
const pendingQuestions = new Map<string, SpeechBlock[]>();
const spokenQuestions = new Set<string>();

function markLiveQuestion(toolCallId: string, owner: string): void {
	if (liveQuestions.has(toolCallId)) return;
	liveQuestions.set(toolCallId, owner);
	const blocks = pendingQuestions.get(toolCallId);
	if (blocks) {
		pendingQuestions.delete(toolCallId);
		speakQuestion(toolCallId, blocks);
	}
}

function speakQuestion(toolCallId: string, blocks: SpeechBlock[]): void {
	const owner = liveQuestions.get(toolCallId);
	if (!owner || spokenQuestions.has(toolCallId)) return;
	spokenQuestions.add(toolCallId);
	appendReply(owner, blocks);
}

/** The dock shows a question: read it if auto-read is on and it arrived live. */
export function offerQuestion(toolCallId: string, blocks: SpeechBlock[]): void {
	if (!state.autoRead || spokenQuestions.has(toolCallId)) return;
	if (liveQuestions.has(toolCallId)) speakQuestion(toolCallId, blocks);
	else pendingQuestions.set(toolCallId, blocks);
}

// ─── config ──────────────────────────────────────────────────────────────────

let configRequested = false;

async function refreshConfig(): Promise<void> {
	try {
		const res = await fetch("/api/tts/config");
		const body = (await res.json()) as { ready?: boolean; autoRead?: boolean; speed?: number };
		savedSpeed = isSpeechSpeed(body.speed) ? body.speed : 1;
		// A drag in flight keeps its thumb; the save that ends it reports back.
		set({ ready: body.ready === true, autoRead: body.autoRead === true, ...(speedSave ? {} : { speed: savedSpeed }) });
	} catch {
		// Offline server: keep what we had.
	}
}

function ensureConfig(): void {
	if (configRequested || typeof window === "undefined") return;
	configRequested = true;
	void refreshConfig();
	onSettingsSaved((section) => {
		if (section === "speech") void refreshConfig();
	});
}

/** The composer controls' write: the whole `speech` section with one field changed. */
async function saveSpeechSection(change: (section: SpeechSettings) => SpeechSettings): Promise<void> {
	const current = (await fetch("/api/settings").then((r) => r.json())) as { settings: UserSettings | null };
	const res = await fetch("/api/settings/speech", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(change({ ...(current.settings?.speech ?? {}) })),
	});
	if (!res.ok) throw new Error(`Save failed (${res.status})`);
	notifySettingsSaved("speech");
}

/** The composer toggle's write: autoRead flipped. */
export async function setAutoRead(on: boolean): Promise<void> {
	const before = state.autoRead;
	set({ autoRead: on, error: null });
	if (!on) stopReadAloud();
	try {
		await saveSpeechSection((section) => ({ ...section, autoRead: on }));
	} catch (error) {
		set({ autoRead: before, error: error instanceof Error ? error.message : "Save failed" });
	}
}

const SPEED_SAVE_DELAY_MS = 300;
let speedSave: ReturnType<typeof setTimeout> | null = null;
/** The speed last saved (or read), restored when a save fails. */
let savedSpeed = 1;

/** The composer slider's write (speed slider, owner 2026-10-24): the label
 *  follows the thumb at once, the save waits for the drag to settle. The
 *  server reads the speed per block, so the change is heard from the next
 *  block fetched — the one already prefetched keeps its speed (owner ruling). */
export function setSpeed(speed: number): void {
	set({ speed, error: null });
	if (speedSave) clearTimeout(speedSave);
	speedSave = setTimeout(() => {
		speedSave = null;
		void saveSpeechSection((section) => {
			// Like the Settings field: the default is the key's absence.
			const next = { ...section };
			delete next.speed;
			if (speed !== 1) next.speed = speed;
			return next;
		}).then(
			() => {
				savedSpeed = speed;
			},
			(error: unknown) => set({ speed: savedSpeed, error: error instanceof Error ? error.message : "Save failed" }),
		);
	}, SPEED_SAVE_DELAY_MS);
}

export function useReadAloud(): ReadAloudState {
	useEffect(ensureConfig, []);
	return useSyncExternalStore(subscribe, () => state, () => state);
}

// ─── auto-read ───────────────────────────────────────────────────────────────

const QUESTION_PART_TYPES = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall"]);

function replyText(message: LhViewMessage): string {
	return message.parts
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n\n");
}

/** The spoken blocks of a whole reply (the per-reply button). */
export function replyBlocks(message: LhViewMessage): SpeechBlock[] {
	return speechBlocks(replyText(message));
}

/**
 * Auto-read for the session: every assistant message that streams while
 * this page watches is LIVE; its blocks are queued as closedMarkdown
 * releases them, and the rest when the stream ends. A message that was
 * already on screen and gets continued is spoken from where it stood.
 */
export function useAutoRead(messages: LhViewMessage[], status: string): void {
	const { autoRead } = useReadAloud();
	/** Blocks already handed over (or skipped), per message. */
	const spoken = useRef(new Map<string, number>());
	/** The closed text last parsed, per message — parse only when it moves. */
	const parsed = useRef(new Map<string, string>());
	const live = useRef(new Set<string>());

	useEffect(() => {
		const streaming = status === "submitted" || status === "streaming";
		const last = messages.at(-1);
		if (last?.role === "assistant" && !live.current.has(last.id)) {
			if (streaming) live.current.add(last.id);
			else spoken.current.set(last.id, replyBlocks(last).length); // the baseline a continuation starts from
		}
		for (const message of messages) {
			if (!live.current.has(message.id)) continue;
			const done = !streaming || message !== last;
			const text = replyText(message);
			const lastPart = message.parts.at(-1);
			const closed = done || lastPart?.type !== "text" ? text : closedMarkdown(text);
			if (parsed.current.get(message.id) !== closed) {
				parsed.current.set(message.id, closed);
				const blocks = speechBlocks(closed);
				const from = spoken.current.get(message.id) ?? 0;
				if (blocks.length > from) {
					if (autoRead) appendReply(message.id, blocks.slice(from));
					spoken.current.set(message.id, blocks.length);
				}
			}
			for (const part of message.parts) {
				if (QUESTION_PART_TYPES.has(part.type) && part.toolCallId) markLiveQuestion(part.toolCallId, message.id);
			}
			if (done) live.current.delete(message.id);
		}
	}, [messages, status, autoRead]);
}

// ─── controls ────────────────────────────────────────────────────────────────

const TOGGLE_CLASS =
	"flex h-7 shrink-0 items-center justify-center rounded-md border px-2 text-xs shadow-lg backdrop-blur transition-colors";

/** The composer's auto-read toggle, beside the mic. While speech plays it
 *  is a stop button; ⌘⇧S toggles auto-read from anywhere in the session. */
export function ReadAloudToggle() {
	const { owner, error, ready, autoRead } = useReadAloud();
	const { open: openSettings } = useSettingsDialog();

	useEffect(() => {
		const toggle = () => {
			if (ready) void setAutoRead(!state.autoRead);
			else openSettings("keys");
		};
		window.addEventListener("lh:kbd-toggle-read-aloud", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-read-aloud", toggle);
	}, [ready, openSettings]);

	if (owner !== null) {
		return (
			<Hint label="Stop reading" binding="escape" side="top">
				<button
					type="button"
					onClick={stopReadAloud}
					aria-label="Stop reading aloud"
					data-testid="read-aloud-toggle"
					className={`${TOGGLE_CLASS} border-transparent bg-destructive/10 font-medium text-destructive hover:bg-destructive/20`}
				>
					<SquareIcon className="size-3 fill-current" />
				</button>
			</Hint>
		);
	}

	const label = error ?? (!ready ? "Read aloud: set a text-to-speech URL in Settings" : autoRead ? "Auto-read is on" : "Auto-read replies");
	return (
		<Hint label={label} action={error || !ready ? undefined : "toggle-read-aloud"} side="top">
			<button
				type="button"
				onClick={() => {
					if (!ready) openSettings("keys");
					else if (error) set({ error: null });
					else void setAutoRead(!autoRead);
				}}
				aria-label={label}
				aria-pressed={autoRead}
				data-testid="read-aloud-toggle"
				className={`${TOGGLE_CLASS} ${
					error
						? "border-destructive/40 bg-card/50 text-destructive"
						: autoRead
							? "border-border bg-card text-foreground"
							: "border-border/50 bg-card/50 text-muted-foreground/70 hover:border-border hover:text-muted-foreground"
				}`}
			>
				{autoRead ? <Volume2Icon className="size-3.5" /> : <VolumeXIcon className="size-3.5" />}
			</button>
		</Hint>
	);
}

/** The composer's speed slider, right of the auto-read toggle (speed
 *  slider, owner 2026-10-24): 0.5×–3× in 0.1 steps, the same `speech.speed`
 *  as the Settings field. Hidden until read-aloud has a URL. */
export function ReadAloudSpeed() {
	const { ready, speed } = useReadAloud();
	if (!ready) return null;
	const label = `${speed.toFixed(1)}×`;
	return (
		<Hint label="Reading speed" side="top">
			<div className="flex h-7 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
				<input
					type="range"
					min={SPEECH_SPEED_MIN}
					max={SPEECH_SPEED_MAX}
					step={SPEECH_SPEED_STEP}
					value={speed}
					onChange={(e) => setSpeed(Math.round(Number(e.target.value) * 10) / 10)}
					aria-label="Reading speed"
					aria-valuetext={`${speed.toFixed(1)} times`}
					data-testid="read-aloud-speed"
					className="w-20 accent-foreground"
				/>
				<span className="w-8 tabular-nums" data-testid="read-aloud-speed-label">
					{label}
				</span>
			</div>
		</Hint>
	);
}

/** The per-reply speaker: on hover under a reply with prose; stays shown
 *  while that reply speaks (click again stops). */
export function ReadAloudButton({ message }: { message: LhViewMessage }) {
	const { owner, ready } = useReadAloud();
	const { open: openSettings } = useSettingsDialog();
	if (!replyText(message).trim()) return null;
	const playing = owner === message.id;
	return (
		<div className={`flex ${playing ? "" : "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"}`}>
			<Hint label={playing ? "Stop reading" : ready ? "Read aloud" : "Read aloud: set a text-to-speech URL in Settings"} side="top">
				<button
					type="button"
					data-testid="read-aloud-reply"
					aria-label={playing ? "Stop reading aloud" : "Read this reply aloud"}
					onClick={() => {
						if (playing) stopReadAloud();
						else if (!ready) openSettings("keys");
						else speakReply(message.id, replyBlocks(message));
					}}
					className="flex size-6 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
				>
					{playing ? <SquareIcon className="size-3 fill-current" /> : <Volume2Icon className="size-3.5" />}
				</button>
			</Hint>
		</div>
	);
}
