"use client";
/**
 * The Read aloud tab's engine choice and voice clips (owner, 2026-11-09).
 *
 * - SpeechEngineRows: "Speech server" (an OpenAI-compatible URL, e.g.
 *   AudioAgent) or "On this computer" (the built-in OmniVoice engine,
 *   src/server/omnivoice/). An explicit choice: one never stands in for the
 *   other. With the built-in engine it shows the download: whether this
 *   computer can run it (GPU only), the licenses, the size, the progress, and
 *   a two-step Remove. Writes `speech.engine` (PUT /api/settings/speech,
 *   replace-whole, from a fresh read so the other rows' fields survive).
 * - VoiceClipRows: voices cloned from the user's own recordings (3–10 s WAV
 *   or MP3 plus the words spoken in it), added to and deleted from the chosen
 *   engine (/api/tts/voices).
 *
 * Not on the phone: the Android app reads aloud with its own voices.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
	resolveSpeech,
	SPEECH_CLIP_MAX_SECONDS,
	SPEECH_CLIP_MIN_SECONDS,
	SPEECH_CLIP_NAME_MAX,
	SPEECH_CLIP_PREFIX,
	type SpeechEngineChoice,
	type SpeechSettings,
	type SpeechVoice,
	type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";

const INPUT_CLASS =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const LINK_CLASS = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-50";
const QUIET_LINK_CLASS = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

/** GET /api/tts/engine's `status` (src/server/omnivoice/install.ts). */
interface EngineStatus {
	supported: boolean;
	reason?: string;
	device?: "cuda" | "metal";
	state: "missing" | "downloading" | "ready" | "failed";
	progress: number;
	bytes: number;
	error?: string;
	running: boolean;
}

interface EngineInfo {
	status: EngineStatus;
	licenses: Record<"model" | "audioTokenizer" | "engine" | "cuda", { name: string; url: string }>;
}

/** "4.7 GB". Pure — exported for tests. */
export function formatBytes(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** The built-in engine row's status line. Pure — exported for tests. */
export function engineStatusLine(status: EngineStatus): string {
	if (!status.supported) return "not available";
	const gpu = status.device === "metal" ? "Metal" : "CUDA";
	switch (status.state) {
		case "ready":
			return `ready · ${gpu}${status.running ? " · running" : ""}`;
		case "downloading":
			return `downloading ${Math.floor(status.progress * 100)} %`;
		case "failed":
			return "download failed";
		default:
			return `not downloaded · ${formatBytes(status.bytes)}`;
	}
}

async function readSpeechSection(): Promise<SpeechSettings> {
	const body = (await fetch("/api/settings").then((r) => r.json())) as { settings: UserSettings | null };
	return body.settings?.speech ?? {};
}

/** `server`: the speech server's own rows (its key), shown only while it is the chosen engine. `children`: the rows both engines share. */
export function SpeechEngineRows({ server, children }: { server?: ReactNode; children?: ReactNode } = {}) {
	const [engine, setEngine] = useState<SpeechEngineChoice | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = () =>
		readSpeechSection()
			.then((section) => setEngine(resolveSpeech(section).engine))
			.catch(() => setEngine("url"));
	useEffect(() => {
		void load();
	}, []);
	useSettingsSaved((saved) => {
		if (saved === "speech") void load();
	});

	if (engine === null) return null;

	async function pick(next: SpeechEngineChoice) {
		setError(null);
		// A fresh read: the other rows may have saved the section since this one loaded.
		const section = await readSpeechSection().catch(() => null);
		if (!section) {
			setError("Could not read the settings");
			return;
		}
		const res = await fetch("/api/settings/speech", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...section, engine: next }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? `Save failed (${res.status})`);
			return;
		}
		setEngine(next);
		notifySettingsSaved("speech");
	}

	return (
		<>
			<div className="flex items-center justify-between gap-3 px-1 py-1.5" data-testid="speech-engine-row">
				<span className="font-ui text-xs text-foreground">Voice engine</span>
				<span className="flex items-center gap-1" role="radiogroup" aria-label="Voice engine">
					{(["url", "builtin"] as const).map((choice) => (
						<button
							key={choice}
							type="button"
							role="radio"
							aria-checked={engine === choice}
							data-testid={`speech-engine-${choice}`}
							onClick={() => void pick(choice)}
							className={`rounded-sm px-2 py-0.5 font-ui text-xs transition-colors ${
								engine === choice ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{choice === "url" ? "Speech server" : "On this computer (OmniVoice)"}
						</button>
					))}
				</span>
			</div>
			{engine === "builtin" && <BuiltinEngineRow />}
			{error && (
				<p role="alert" data-testid="speech-engine-error" className="px-1 text-xs text-error">
					{error}
				</p>
			)}
			{children}
			{engine === "url" ? server : null}
		</>
	);
}

function BuiltinEngineRow() {
	const [info, setInfo] = useState<EngineInfo | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = () =>
		fetch("/api/tts/engine")
			.then((r) => r.json())
			.then((body: EngineInfo) => setInfo(body))
			.catch(() => setInfo(null));
	useEffect(() => {
		void load();
	}, []);
	const downloading = info?.status.state === "downloading";
	useEffect(() => {
		if (!downloading) return;
		const timer = setInterval(() => void load(), 1000);
		return () => clearInterval(timer);
	}, [downloading]);

	if (!info) return null;
	const { status, licenses } = info;

	async function download() {
		setError(null);
		const res = await fetch("/api/tts/engine", { method: "POST" });
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			setError(body.message ?? `Download failed (${res.status})`);
		}
		await load();
		notifySettingsSaved("speech");
	}

	async function remove() {
		setError(null);
		setConfirmRemove(false);
		const res = await fetch("/api/tts/engine", { method: "DELETE" });
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			setError(body.message ?? `Remove failed (${res.status})`);
		}
		await load();
		notifySettingsSaved("speech");
	}

	return (
		<div className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="speech-builtin">
			<div className="flex items-center justify-between gap-3">
				<span className="font-ui text-xs text-foreground">OmniVoice</span>
				<span className="font-mono text-[11px] text-muted-foreground" data-testid="speech-builtin-status">
					{engineStatusLine(status)}
				</span>
			</div>
			{!status.supported ? (
				<p className="text-[11px] leading-relaxed text-muted-foreground/70" data-testid="speech-builtin-reason">
					{status.reason}. Use a speech server instead (e.g. AudioAgent on a computer with a GPU).
				</p>
			) : status.state === "ready" ? (
				<div className="flex items-center gap-3">
					<span className="text-[11px] text-muted-foreground/70">Reads English and German; starts with the first block, stops after 10 idle minutes.</span>
					{confirmRemove ? (
						<>
							<button type="button" onClick={() => void remove()} data-testid="speech-builtin-remove-confirm" className="shrink-0 text-xs text-error underline-offset-2 hover:underline">
								Remove {formatBytes(status.bytes)}
							</button>
							<button type="button" onClick={() => setConfirmRemove(false)} className={QUIET_LINK_CLASS}>
								Keep
							</button>
						</>
					) : (
						<button type="button" onClick={() => setConfirmRemove(true)} data-testid="speech-builtin-remove" className={QUIET_LINK_CLASS}>
							Remove
						</button>
					)}
				</div>
			) : status.state === "downloading" ? (
				<div className="h-1 w-full overflow-hidden rounded-sm bg-accent" role="progressbar" aria-valuenow={Math.floor(status.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
					<div className="h-full bg-muted-foreground/60" style={{ width: `${Math.floor(status.progress * 100)}%` }} />
				</div>
			) : (
				<>
					<p className="text-[11px] leading-relaxed text-muted-foreground/70" data-testid="speech-builtin-licenses">
						Downloads the OmniVoice model ({" "}
						<a href={licenses.model.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
							{licenses.model.name}
						</a>
						; its audio tokenizer under the{" "}
						<a href={licenses.audioTokenizer.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
							{licenses.audioTokenizer.name}
						</a>
						), the omnivoice-rs engine ({licenses.engine.name})
						{status.device === "cuda" && (
							<>
								{" "}and{" "}
								<a href={licenses.cuda.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
									{licenses.cuda.name}
								</a>
							</>
						)}
						, {formatBytes(status.bytes)} in all. Needs about 2 GB of GPU memory while it reads.
					</p>
					{status.state === "failed" && status.error && (
						<p className="text-[11px] text-error" data-testid="speech-builtin-failed">
							{status.error}
						</p>
					)}
					<div>
						<button type="button" onClick={() => void download()} data-testid="speech-builtin-download" className={LINK_CLASS}>
							{status.state === "failed" ? "Try again" : `Accept and download ${formatBytes(status.bytes)}`}
						</button>
					</div>
				</>
			)}
			{error && (
				<p role="alert" className="text-xs text-error">
					{error}
				</p>
			)}
		</div>
	);
}

/** The clip voices of a voice list. Pure — exported for tests. */
export function clipVoices(voices: readonly SpeechVoice[]): SpeechVoice[] {
	return voices.filter((v) => v.id.startsWith(SPEECH_CLIP_PREFIX));
}

export function VoiceClipRows() {
	const [voices, setVoices] = useState<SpeechVoice[] | null>(null);
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");
	const [transcript, setTranscript] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = () =>
		fetch("/api/tts/voices")
			.then((r) => (r.ok ? r.json() : { voices: null }))
			.then((body: { voices?: SpeechVoice[] | null }) => setVoices(body.voices ?? null))
			.catch(() => setVoices(null));
	useEffect(() => {
		void load();
	}, []);
	useSettingsSaved((saved) => {
		if (saved === "speech") void load();
	});

	// No voice list: no URL yet, or the server is unreachable — nothing to manage.
	if (voices === null) return null;
	const clips = clipVoices(voices);

	async function add() {
		setError(null);
		if (!file) {
			setError("Choose a recording (WAV or MP3)");
			return;
		}
		const form = new FormData();
		form.append("name", name);
		form.append("transcript", transcript);
		form.append("audio", file);
		setBusy(true);
		const res = await fetch("/api/tts/voices", { method: "POST", body: form }).catch(() => null);
		setBusy(false);
		if (!res?.ok) {
			const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
			setError(body?.message ?? "Adding the voice failed");
			return;
		}
		setAdding(false);
		setName("");
		setTranscript("");
		setFile(null);
		await load();
		notifySettingsSaved("speech");
	}

	async function remove(id: string) {
		setError(null);
		const res = await fetch(`/api/tts/voices/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
		if (!res?.ok && res?.status !== 404) {
			const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
			setError(body?.message ?? "Deleting the voice failed");
		}
		await load();
		notifySettingsSaved("speech");
	}

	return (
		<div className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="speech-clips">
			<div className="flex items-center justify-between gap-3">
				<span className="font-ui text-xs text-foreground">Your voices</span>
				{!adding && (
					<button type="button" onClick={() => setAdding(true)} data-testid="speech-clip-add" className={LINK_CLASS}>
						Add a voice
					</button>
				)}
			</div>
			{clips.map((clip) => (
				<div key={clip.id} className="flex items-center justify-between gap-3" data-testid={`speech-clip-${clip.id}`}>
					<span className="font-mono text-[11px] text-muted-foreground">{clip.id}</span>
					<button type="button" onClick={() => void remove(clip.id)} className={QUIET_LINK_CLASS}>
						Delete
					</button>
				</div>
			))}
			{adding && (
				<div className="flex flex-col gap-1.5" data-testid="speech-clip-editor">
					<p className="text-[11px] leading-relaxed text-muted-foreground/70">
						A recording of {SPEECH_CLIP_MIN_SECONDS} to {SPEECH_CLIP_MAX_SECONDS} seconds (WAV or MP3) of the voice, and the exact words spoken in it. Only add a voice you may use.
					</p>
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={SPEECH_CLIP_NAME_MAX}
						placeholder="name, e.g. My voice"
						aria-label="Voice name"
						data-testid="speech-clip-name"
						className={INPUT_CLASS}
					/>
					<textarea
						value={transcript}
						onChange={(e) => setTranscript(e.target.value)}
						rows={2}
						placeholder="the words spoken in the recording"
						aria-label="Transcript"
						data-testid="speech-clip-transcript"
						className={`${INPUT_CLASS} h-auto py-1`}
					/>
					<div className="flex items-center gap-2">
						<input
							type="file"
							accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3"
							onChange={(e) => setFile(e.target.files?.[0] ?? null)}
							aria-label="Recording"
							data-testid="speech-clip-file"
							className="min-w-0 flex-1 text-xs text-muted-foreground"
						/>
						<button type="button" disabled={busy} onClick={() => void add()} data-testid="speech-clip-save" className={LINK_CLASS}>
							{busy ? "Adding…" : "Add"}
						</button>
						<button
							type="button"
							onClick={() => {
								setAdding(false);
								setError(null);
							}}
							className={QUIET_LINK_CLASS}
						>
							Cancel
						</button>
					</div>
				</div>
			)}
			{error && (
				<p role="alert" data-testid="speech-clip-error" className="text-xs text-error">
					{error}
				</p>
			)}
		</div>
	);
}
