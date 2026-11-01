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

import { useEffect, useSyncExternalStore } from "react";
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

function set(patch: Partial<VoiceModeState>): void {
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

/** The claimed target: the same field that holds the dictation claim
 *  (dictation.tsx useDictationTarget) — question, practice or
 *  thinking-while-reading. The composer is the fallback. */
let claimed: { kind: Exclude<TargetKind, "composer">; submit: Submit | null } | null = null;
let composerSubmit: Submit | null = null;
let reveal: (() => void) | null = null;
let next: (() => void) | null = null;

/** Claim the voice target while mounted and `active`, beside the dictation claim. */
export function useVoiceTarget(kind: Exclude<TargetKind, "composer">, submit: Submit | null, active: boolean): void {
	useEffect(() => {
		if (!active) return;
		const entry = { kind, submit };
		claimed = entry;
		return () => {
			if (claimed === entry) claimed = null;
		};
	}, [kind, submit, active]);
}

/** The composer's send, the fallback target's submit. */
export function useVoiceComposer(submit: Submit): void {
	useEffect(() => {
		composerSubmit = submit;
		return () => {
			if (composerSubmit === submit) composerSubmit = null;
		};
	}, [submit]);
}

/** Offer the teach-check reveal (null: nothing waits behind one). */
export function useVoiceReveal(open: (() => void) | null): void {
	useEffect(() => {
		if (!open) return;
		reveal = open;
		return () => {
			if (reveal === open) reveal = null;
		};
	}, [open]);
}

/** Offer the practice move-on (null: not in the between-problems pause). */
export function useVoiceNext(go: (() => void) | null): void {
	useEffect(() => {
		if (!go) return;
		next = go;
		return () => {
			if (next === go) next = null;
		};
	}, [go]);
}

// ─── the app's calls ─────────────────────────────────────────────────────────

/** One utterance: act on it, true when the page did something. */
export function handleVoiceEvent(event: VoiceEvent): boolean {
	const context: VoiceContext = {
		target: claimed?.kind ?? "composer",
		reading: readAloudReading(),
		canReveal: reveal !== null,
		canNext: next !== null,
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
			const submit = claimed ? claimed.submit : composerSubmit;
			return submit ? submit() : false;
		}
		case "reveal":
			reveal?.();
			return reveal !== null;
		case "next":
			next?.();
			return next !== null;
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
		started: () => set({ phase: "on", error: null }),
		// A reading paused by a barge-in stays paused (the toggle's stop ends it).
		ended: (reason) => set({ phase: "off", error: reason || null }),
		speechStarted: () => pauseReadAloud(),
		command: (name) => isVoiceCommand(name) && handleVoiceEvent({ type: "command", command: name }),
		text: (transcript) => handleVoiceEvent({ type: "text", text: transcript }),
		noise: () => handleVoiceEvent({ type: "noise" }),
	};
	(window as { lhVoice?: PageVoiceHandlers }).lhVoice = handlers;
	// A reloaded page finds voice mode still on in the app.
	set({ available: true, phase: android.voiceModeActive() ? "on" : "off" });
}

export function startVoiceMode(): void {
	const android = bridge();
	if (!android || state.phase !== "off") return;
	set({ phase: "starting", error: null });
	const error = android.voiceModeStart();
	if (error) set({ phase: "off", error });
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
