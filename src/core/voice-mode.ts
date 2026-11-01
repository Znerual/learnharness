/**
 * VOICE MODE (ADR-0005, glossary "Voice mode"): the phone listens,
 * transcribes and matches voice commands; the page decides what each
 * utterance does. voiceAction is that decision.
 *
 * PURE, browser-safe.
 */

/** The voice commands, as the phone sends them. */
export const VOICE_COMMANDS = ["continue", "restart", "stop", "send", "reveal", "next", "voice-off"] as const;
export type VoiceCommand = (typeof VOICE_COMMANDS)[number];

export function isVoiceCommand(value: unknown): value is VoiceCommand {
	return typeof value === "string" && (VOICE_COMMANDS as readonly string[]).includes(value);
}

/** One utterance from the phone: a voice command, dictated text, or speech
 *  that transcribed to nothing (a cough, background noise). */
export type VoiceEvent = { type: "command"; command: VoiceCommand } | { type: "text"; text: string } | { type: "noise" };

/** Where read-aloud stands: nothing read yet, speaking, paused by a
 *  barge-in, or stopped with a reading that a restart can replay. */
export type VoiceReading = "idle" | "playing" | "paused" | "stopped";

export interface VoiceContext {
	/** The field that holds the dictation target. */
	target: "composer" | "question" | "practice" | "reading-thinking";
	reading: VoiceReading;
	/** A teach-phase check waits behind its reveal. */
	canReveal: boolean;
	/** The practice between-problems pause takes the move-on signal. */
	canNext: boolean;
}

export type VoiceAction =
	| { type: "append"; text: string }
	| { type: "resume-reading" }
	| { type: "restart-reading" }
	| { type: "stop-reading" }
	| { type: "submit" }
	| { type: "reveal" }
	| { type: "next" }
	| { type: "voice-off" }
	| { type: "none" }
	| { type: "refuse" };

export function voiceAction(event: VoiceEvent, context: VoiceContext): VoiceAction {
	if (event.type === "text") return { type: "append", text: event.text };
	// Speech that transcribed to nothing was no real barge-in.
	if (event.type === "noise") return context.reading === "paused" ? { type: "resume-reading" } : { type: "none" };
	switch (event.command) {
		case "continue":
			return context.reading === "paused" ? { type: "resume-reading" } : { type: "refuse" };
		case "restart":
			return context.reading === "idle" ? { type: "refuse" } : { type: "restart-reading" };
		case "stop":
			return context.reading === "playing" || context.reading === "paused" ? { type: "stop-reading" } : { type: "refuse" };
		case "send":
			// The thinking-while-reading field has no submit of its own: it
			// rides the check answer, so sending it opens the check (owner).
			if (context.target === "reading-thinking") return context.canReveal ? { type: "reveal" } : { type: "refuse" };
			return { type: "submit" };
		case "reveal":
			return context.canReveal ? { type: "reveal" } : { type: "refuse" };
		case "next":
			return context.canNext ? { type: "next" } : { type: "refuse" };
		case "voice-off":
			return { type: "voice-off" };
	}
}
