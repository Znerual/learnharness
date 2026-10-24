"use client";
/**
 * The read-aloud row of the Keys section's Read aloud group
 * (read-aloud wave, owner 2026-10-24): the OpenAI-compatible
 * text-to-speech endpoint's base URL, voice and speed (click-unfold
 * editor, the dictation rows' look). The voice list comes from the
 * endpoint (GET /api/tts/voices); the optional key is the curated
 * LH_TTS_KEY row in the same group. Writes the `speech` settings section
 * (PUT /api/settings/speech, replace-whole — autoRead rides along).
 */

import { useEffect, useState } from "react";
import {
	normalizeBaseUrl,
	resolveSpeech,
	SPEECH_SPEED_MAX,
	SPEECH_SPEED_MIN,
	type SpeechSettings,
	type UserSettings,
} from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

const INPUT_CLASS =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

/** The row's status line. Pure — exported for tests. */
export function speechStatusLine(section: SpeechSettings | undefined): string {
	const { url, voice, speed } = resolveSpeech(section);
	if (!url) return "not set";
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		// stored URLs are normalized; the raw string is the fallback
	}
	return [host, voice, speed !== 1 ? `${speed}×` : null].filter(Boolean).join(" · ");
}

export function SpeechRows() {
	const [section, setSection] = useState<SpeechSettings | null>(null);
	const [editing, setEditing] = useState(false);
	const [url, setUrl] = useState("");
	const [voice, setVoice] = useState("");
	const [speed, setSpeed] = useState("1");
	const [voices, setVoices] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings: UserSettings | null }) => setSection(body.settings?.speech ?? {}))
			.catch(() => setSection({}));
	}, []);

	// The voice list, from the SAVED endpoint, each time the editor opens.
	useEffect(() => {
		if (!editing || !section?.url) {
			setVoices(null);
			return;
		}
		let cancelled = false;
		fetch("/api/tts/voices")
			.then((r) => r.json())
			.then((body: { voices?: string[] }) => {
				if (!cancelled) setVoices(body.voices ?? null);
			})
			.catch(() => {
				if (!cancelled) setVoices(null);
			});
		return () => {
			cancelled = true;
		};
	}, [editing, section?.url]);

	if (section === null) return null;
	const effective = resolveSpeech(section);

	async function save() {
		setError(null);
		const trimmed = url.trim();
		if (trimmed && !normalizeBaseUrl(trimmed)) {
			setError("Base URL must be an http(s) URL, e.g. http://localhost:8110/v1");
			return;
		}
		const speedValue = Number(speed);
		if (!Number.isFinite(speedValue) || speedValue < SPEECH_SPEED_MIN || speedValue > SPEECH_SPEED_MAX) {
			setError(`Speed must be from ${SPEECH_SPEED_MIN} to ${SPEECH_SPEED_MAX}`);
			return;
		}
		const next: SpeechSettings = { ...section };
		delete next.url;
		delete next.voice;
		delete next.speed;
		if (trimmed) next.url = trimmed;
		if (voice.trim()) next.voice = voice.trim();
		if (speedValue !== 1) next.speed = speedValue;
		const res = await fetch("/api/settings/speech", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(next),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? `Save failed (${res.status})`);
			return;
		}
		setSection(next);
		notifySettingsSaved("speech");
		setEditing(false);
	}

	const onEnter = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") void save();
	};

	return (
		<>
			{editing ? (
				<div className="flex flex-col gap-1.5 rounded-sm px-1 py-1.5" data-testid="speech-editor">
					<div className="flex items-center gap-2">
						<span className="shrink-0 font-ui text-xs text-foreground">Read aloud</span>
						<input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={onEnter}
							placeholder="http://localhost:8110/v1"
							aria-label="Text-to-speech base URL"
							data-testid="speech-url"
							autoFocus
							className={INPUT_CLASS}
						/>
					</div>
					<div className="flex items-center gap-2">
						{voices && voices.length > 0 ? (
							<select
								value={voice}
								onChange={(e) => setVoice(e.target.value)}
								aria-label="Voice"
								data-testid="speech-voice"
								className={INPUT_CLASS}
							>
								<option value="">server default voice</option>
								{voice && !voices.includes(voice) && <option value={voice}>{voice}</option>}
								{voices.map((v) => (
									<option key={v} value={v}>
										{v}
									</option>
								))}
							</select>
						) : (
							<input
								value={voice}
								onChange={(e) => setVoice(e.target.value)}
								onKeyDown={onEnter}
								placeholder="voice (optional)"
								aria-label="Voice"
								data-testid="speech-voice"
								className={INPUT_CLASS}
							/>
						)}
						<input
							type="number"
							value={speed}
							min={SPEECH_SPEED_MIN}
							max={SPEECH_SPEED_MAX}
							step={0.05}
							onChange={(e) => setSpeed(e.target.value)}
							onKeyDown={onEnter}
							aria-label="Speed"
							data-testid="speech-speed"
							className={`${INPUT_CLASS} max-w-20`}
						/>
						<button
							type="button"
							onClick={() => void save()}
							data-testid="speech-save"
							className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setEditing(false);
								setError(null);
							}}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					data-testid="speech-row"
					onClick={() => {
						setUrl(effective.url ?? "");
						setVoice(effective.voice ?? "");
						setSpeed(String(effective.speed));
						setEditing(true);
					}}
					className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
				>
					<span className="font-ui text-xs text-foreground">Read aloud</span>
					<span className="font-mono text-[11px] text-muted-foreground">{speechStatusLine(section)}</span>
				</button>
			)}
			{error && (
				<p role="alert" data-testid="speech-error" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</>
	);
}
