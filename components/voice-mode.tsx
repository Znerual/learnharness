"use client";
/**
 * VOICE MODE, the page half (ADR-0005). The Android app owns the
 * microphone: it listens with the screen off, transcribes each utterance
 * on the phone, matches voice commands, and hands the page one event per
 * utterance through `window.lhVoice`. The page decides what each one does
 * (core voiceAction): dictated text lands in the dictation target, the
 * commands drive read-aloud and submit, reveal or move on.
 *
 * The bridge, both ways:
 * - page → app: `LHAndroid.voiceModeStart()`, `voiceModeStop()`,
 *   `voiceModeActive()`.
 * - app → page: `lhVoice.started()`, `lhVoice.ended(reason)`,
 *   `lhVoice.speechStarted()` (barge-in), and `command(name)`,
 *   `text(transcript)`, `noise()` — each answers true when the page acted,
 *   false when it refused (the app plays the matching earcon).
 *
 * Module-level state, the read-aloud pattern: the handlers outlive any
 * one session page, and the claimants live in unrelated subtrees.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AudioLinesIcon } from "lucide-react";
import { isVoiceCommand, voiceAction, type VoiceContext, type VoiceEvent } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { appendToPrimaryInput } from "@/components/dictation";
import {
	pauseReadAloud,
	readAloudReading,
	restartReadAloud,
	resumeReadAloud,
	setVoiceAutoRead,
	stopReadAloud,
} from "@/components/read-aloud";

// ─── state ───────────────────────────────────────────────────────────────────

export interface VoiceModeState {
	/** The app offers voice mode (the Android bridge has it). */
	available: boolean;
	phase: "off" | "starting" | "on";
	/** Why voice mode last ended or failed to start, shown on the toggle. */
	error: string | null;
}

let state: VoiceModeState = { available: false, phase: "off", error: null };
const listeners = new Set<() => void>();

/** Change the state; auto-read follows it, on exactly while voice mode is on. */
function update(patch: Partial<VoiceModeState>): void {
	state = { ...state, ...patch };
	setVoiceAutoRead(state.phase === "on");
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

interface AndroidVoiceBridge {
	/** Starts voice mode; answers an error message, or "" when it is starting. */
	voiceModeStart(): string;
	voiceModeStop(): void;
	voiceModeActive(): boolean;
}

function bridge(): AndroidVoiceBridge | null {
	if (typeof window === "undefined") return null;
	const android = (window as { LHAndroid?: Partial<AndroidVoiceBridge> }).LHAndroid;
	return typeof android?.voiceModeStart === "function" ? (android as AndroidVoiceBridge) : null;
}

// ─── claimants ───────────────────────────────────────────────────────────────

type TargetKind = VoiceContext["target"];
/** Submits the field; false when there is nothing to submit. */
type Submit = () => boolean;
type ClaimedTarget = { kind: Exclude<TargetKind, "composer">; submit: Submit | null };

/** One registration a mounted part offers voice mode; the last mounted wins. */
interface Slot<T> {
	current: T | null;
}

/** Hold `slot` with `value` while mounted (null: offer nothing). The
 *  release is identity-based, like useDictationTarget's. */
function useSlot<T>(slot: Slot<T>, value: T | null): void {
	useEffect(() => {
		if (value === null) return;
		slot.current = value;
		return () => {
			if (slot.current === value) slot.current = null;
		};
	}, [slot, value]);
}

/** A stable submit that always runs the caller's latest closure. */
function useLatestSubmit(submit: Submit | null): Submit | null {
	const latest = useRef(submit);
	latest.current = submit;
	const stable = useMemo<Submit>(() => () => latest.current?.() ?? false, []);
	return submit ? stable : null;
}

/** The claimed target: the same field that holds the dictation claim
 *  (dictation.tsx useDictationTarget) — question, practice or
 *  thinking-while-reading. The composer is the fallback. */
const claimed: Slot<ClaimedTarget> = { current: null };
const composer: Slot<Submit> = { current: null };
const reveal: Slot<() => void> = { current: null };
const next: Slot<() => void> = { current: null };

/** Submit when `ok`; the answer voice mode's earcon reports. */
export function submitIf(ok: boolean, submit: () => void): boolean {
	if (ok) submit();
	return ok;
}

/** Claim the voice target while mounted and `active`, beside the dictation claim. */
export function useVoiceTarget(kind: ClaimedTarget["kind"], submit: Submit | null, active: boolean): void {
	const stable = useLatestSubmit(submit);
	const target = useMemo<ClaimedTarget>(() => ({ kind, submit: stable }), [kind, stable]);
	useSlot(claimed, active ? target : null);
}

/** The composer's send, the fallback target's submit. */
export function useVoiceComposer(submit: Submit): void {
	useSlot(composer, useLatestSubmit(submit));
}

/** Offer the teach-check reveal (null: nothing waits behind one). */
export function useVoiceReveal(open: (() => void) | null): void {
	useSlot(reveal, open);
}

/** Offer the practice move-on (null: not in the between-problems pause). */
export function useVoiceNext(go: (() => void) | null): void {
	useSlot(next, go);
}

// ─── the app's calls ─────────────────────────────────────────────────────────

/** One utterance: act on it, true when the page did something. */
export function handleVoiceEvent(event: VoiceEvent): boolean {
	const context: VoiceContext = {
		target: claimed.current?.kind ?? "composer",
		reading: readAloudReading(),
		canReveal: reveal.current !== null,
		canNext: next.current !== null,
	};
	const action = voiceAction(event, context);
	switch (action.type) {
		case "append":
			return appendToPrimaryInput(action.text);
		case "resume-reading":
			resumeReadAloud();
			return true;
		case "restart-reading":
			return restartReadAloud();
		case "stop-reading":
			stopReadAloud();
			return true;
		case "submit": {
			const submit = claimed.current ? claimed.current.submit : composer.current;
			return submit ? submit() : false;
		}
		case "reveal":
			reveal.current?.();
			return reveal.current !== null;
		case "next":
			next.current?.();
			return next.current !== null;
		case "voice-off":
			stopVoiceMode();
			return true;
		case "none":
			return true;
		case "refuse":
			return false;
	}
}

interface PageVoiceHandlers {
	started(): void;
	ended(reason?: string): void;
	speechStarted(): void;
	command(name: string): boolean;
	text(transcript: string): boolean;
	noise(): boolean;
}

let installed = false;

function install(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const android = bridge();
	if (!android) return;
	const handlers: PageVoiceHandlers = {
		started: () => update({ phase: "on", error: null }),
		// A reading paused by a barge-in stays paused (the toggle's stop ends it).
		ended: (reason) => update({ phase: "off", error: reason || null }),
		speechStarted: () => pauseReadAloud(),
		command: (name) => isVoiceCommand(name) && handleVoiceEvent({ type: "command", command: name }),
		text: (transcript) => handleVoiceEvent({ type: "text", text: transcript }),
		noise: () => handleVoiceEvent({ type: "noise" }),
	};
	(window as { lhVoice?: PageVoiceHandlers }).lhVoice = handlers;
	// A reloaded page finds voice mode still on in the app.
	update({ available: true, phase: android.voiceModeActive() ? "on" : "off" });
}

export function startVoiceMode(): void {
	const android = bridge();
	if (!android || state.phase !== "off") return;
	update({ phase: "starting", error: null });
	// A JavaScript bridge returns only primitives: "" means no error.
	const error = android.voiceModeStart();
	if (error) update({ phase: "off", error });
}

export function stopVoiceMode(): void {
	bridge()?.voiceModeStop();
}

export function useVoiceMode(): VoiceModeState {
	useEffect(install, []);
	return useSyncExternalStore(subscribe, () => state, () => state);
}

// ─── control ─────────────────────────────────────────────────────────────────

const TOGGLE_CLASS =
	"flex h-7 shrink-0 items-center justify-center rounded-md border px-2 text-xs shadow-lg backdrop-blur transition-colors";

/** The composer's voice-mode toggle, beside auto-read; only in the Android app. */
export function VoiceModeToggle() {
	const { available, phase, error } = useVoiceMode();
	if (!available) return null;
	const on = phase !== "off";
	const label = error ?? (phase === "on" ? "Voice mode is on" : phase === "starting" ? "Voice mode is starting" : "Voice mode");
	return (
		<Hint label={label} side="top">
			<button
				type="button"
				onClick={() => {
					if (on) stopVoiceMode();
					else startVoiceMode();
				}}
				aria-label={label}
				aria-pressed={on}
				data-testid="voice-mode-toggle"
				className={`${TOGGLE_CLASS} ${
					error && !on
						? "border-destructive/40 bg-card/50 text-destructive"
						: on
							? "border-transparent bg-primary/15 text-foreground"
							: "border-border/50 bg-card/50 text-muted-foreground/70 hover:border-border hover:text-muted-foreground"
				}`}
			>
				<AudioLinesIcon className={`size-3.5 ${phase === "starting" ? "animate-pulse" : ""}`} />
			</button>
		</Hint>
	);
}

/** In place of the dictation mic while voice mode listens: the app holds the microphone. */
export function VoiceModeStatus() {
	return (
		<div className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground" data-testid="voice-mode-status">
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
			Listening
		</div>
	);
}
