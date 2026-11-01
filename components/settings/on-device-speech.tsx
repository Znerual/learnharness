"use client";
/**
 * Settings → Providers → On-device speech (Android app, owner 2026-11-01):
 * the phone's own dictation and read-aloud models. Nothing downloads by
 * itself; each model is downloaded here on demand (Wi-Fi only) and can be
 * removed again. Reads and changes go through /api/speech-models to the
 * phone's speech server. Shown only inside the Android app, and only while
 * that server answers.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { SPEECH_LANGUAGE_LABEL, isSpeechLanguage, type NpuSpeechStatus, type OnDeviceModel, type SpeechBenchmarkModel, type SpeechBenchmarkResult } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup } from "./controls.tsx";

/** "670 MB". Pure — exported for tests. */
export function modelSize(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/** The model's state in words. Pure — exported for tests. */
export function modelStateLine(model: OnDeviceModel): string {
	switch (model.state) {
		case "ready":
			return "Downloaded";
		case "downloading":
			return `Downloading ${Math.round(model.progress * 100)} %`;
		case "waiting":
			return `Waits for Wi-Fi (${Math.round(model.progress * 100)} %)`;
		case "failed":
			return `Download failed — ${model.error ?? "try again"}`;
		default:
			return modelSize(model.bytes);
	}
}

const PROVIDER_LABEL: Record<string, string> = { cpu: "CPU", nnapi: "NNAPI", gpu: "GPU", npu: "NPU" };

/** The benchmark's verdict in words. Pure — exported for tests. */
export function benchmarkLine(result: SpeechBenchmarkResult | null): string {
	if (!result) return "Not run yet — voice mode appears once a run finds this phone fast enough.";
	const speed = (part: SpeechBenchmarkModel | null | undefined, name: string) =>
		part ? `${name} ${part.rtf.toFixed(2)} s per second of audio (${PROVIDER_LABEL[part.provider] ?? part.provider})` : `${name} failed`;
	const verdict = result.voiceMode ? "Fast enough for voice mode" : "Too slow for voice mode";
	const split = result.kokoro !== undefined || result.piperHigh !== undefined || result.piperMedium !== undefined;
	const voices = [
		split ? null : speed(result.voice, "read-aloud"),
		result.kokoro ? speed(result.kokoro, "Kokoro") : null,
		result.piperHigh ? speed(result.piperHigh, "Piper high") : null,
		result.piperMedium ? speed(result.piperMedium, "Piper medium") : null,
	].filter((part): part is string => part !== null);
	const slow = [result.kokoroFast === false ? "Kokoro" : null, result.piperHighFast === false ? "the high-quality Piper voices" : null].filter(
		(name): name is string => name !== null,
	);
	const hidden = slow.length ? ` Too slow here, so not offered: ${slow.join(" and ")}.` : "";
	return `${verdict}: ${[speed(result.dictation, "dictation"), ...voices].join(", ")}.${hidden}`;
}

/** Settings row: run the phone's speed check, which decides whether voice mode is offered. */
function BenchmarkRow() {
	const [result, setResult] = useState<SpeechBenchmarkResult | null | undefined>(undefined);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const call = useCallback(async (method: "GET" | "POST") => {
		const res = await fetch("/api/speech-benchmark", { method }).catch(() => null);
		const body = (await res?.json().catch(() => ({}))) as { result?: SpeechBenchmarkResult | null; error?: string } | undefined;
		if (!res?.ok) {
			setError(body?.error ?? "The phone's speech server did not answer.");
			return;
		}
		setError(null);
		setResult(body?.result ?? null);
	}, []);

	useEffect(() => {
		void call("GET");
	}, [call]);

	async function run() {
		setRunning(true);
		await call("POST");
		setRunning(false);
		// Voice mode's toggle re-reads whether this phone offers it.
		notifySettingsSaved("speech");
	}

	if (result === undefined && !error) return null;
	return (
		<div className="flex items-center justify-between gap-3 px-1 py-1.5" data-testid="speech-benchmark">
			<span className="min-w-0 flex-1">
				<span className="block font-ui text-xs text-foreground">Voice mode speed check</span>
				<span className="block font-mono text-[11px] text-muted-foreground" data-testid="speech-benchmark-result">
					{running ? "Running — this takes about a minute…" : error ?? benchmarkLine(result ?? null)}
				</span>
			</span>
			<button
				type="button"
				onClick={() => void run()}
				disabled={running}
				data-testid="speech-benchmark-run"
				className="flex shrink-0 items-center gap-1 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-50"
			>
				{running && <Loader2Icon className="size-3 animate-spin" aria-hidden />}
				{result ? "Run again" : "Run"}
			</button>
		</div>
	);
}

/** One voice's NPU state in words. Pure — exported for tests. */
export function npuVoiceLine(v: NpuSpeechStatus["voices"][number]): string {
	switch (v.state) {
		case "voice-missing":
			return "Download this voice first";
		case "off":
			return "Off";
		case "waiting":
			return "Waiting";
		case "downloading":
			return "Downloading its NPU files (Wi-Fi only)";
		case "compiling":
			return "Compiling for this phone's chip — up to a few minutes, once";
		case "testing":
			return "Testing against the CPU voice";
		case "ready":
			return "Reads on the NPU";
		case "failed":
			return `Reads on the CPU — ${v.error ?? "the NPU failed"}`;
	}
}

/** Settings row: NPU speech (experimental), only on a phone whose chip supports it. */
function NpuSpeechRow() {
	const [npu, setNpu] = useState<NpuSpeechStatus | null>(null);
	const [error, setError] = useState<string | null>(null);

	const call = useCallback(async (init?: RequestInit) => {
		const res = await fetch("/api/npu-speech", init).catch(() => null);
		const body = (await res?.json().catch(() => null)) as (NpuSpeechStatus & { error?: string }) | null;
		if (!res?.ok || !body) {
			setError(body?.error ?? null);
			return;
		}
		setError(null);
		setNpu(body);
	}, []);

	useEffect(() => {
		void call();
	}, [call]);

	// Follow the preparation while a voice downloads, compiles or tests.
	const busy = npu?.voices.some((v) => v.state === "waiting" || v.state === "downloading" || v.state === "compiling" || v.state === "testing") ?? false;
	useEffect(() => {
		if (!busy) return;
		const timer = setInterval(() => void call(), 3000);
		return () => clearInterval(timer);
	}, [busy, call]);

	if (!npu?.offered) return null;
	return (
		<div className="px-1 py-1.5" data-testid="npu-speech">
			<label className="flex items-center justify-between gap-3">
				<span className="min-w-0 flex-1">
					<span className="block font-ui text-xs text-foreground">NPU speech (experimental)</span>
					<span className="block font-mono text-[11px] text-muted-foreground">
						Piper voices read on this phone&apos;s NPU ({npu.soc}), which leaves the CPU free.
					</span>
				</span>
				<input
					type="checkbox"
					checked={npu.enabled}
					onChange={(e) =>
						void call({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: e.target.checked }) })
					}
					data-testid="npu-speech-toggle"
					className="size-4 accent-foreground"
				/>
			</label>
			{npu.enabled &&
				npu.voices
					.filter((v) => v.state !== "voice-missing")
					.map((v) => (
						<span key={v.voice} className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" data-testid={`npu-voice-${v.voice}`}>
							{v.label} · {npuVoiceLine(v)}
						</span>
					))}
			{error && (
				<p role="alert" className="mt-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}

function modelName(model: OnDeviceModel): string {
	if (model.kind === "dictation") return "Dictation";
	const language = isSpeechLanguage(model.language) ? SPEECH_LANGUAGE_LABEL[model.language] : model.language;
	return `Read-aloud voice · ${language}`;
}

/** The group, or nothing while the speech server is not an on-device one.
 *  `part` picks the tab it sits in: the dictation model and the voice-mode
 *  speed check under Dictation, the voices and NPU speech under Read aloud. */
export function OnDeviceSpeechGroup({ part }: { part: "dictation" | "read-aloud" }) {
	const [models, setModels] = useState<OnDeviceModel[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const apply = useCallback(async (res: Response | null) => {
		if (!res) return setError("The phone's speech server did not answer.");
		const body = (await res.json().catch(() => ({}))) as { models?: OnDeviceModel[]; error?: string };
		if (!res.ok) {
			if (res.status === 404) setModels(null);
			else setError(body.error ?? `HTTP ${res.status}`);
			return;
		}
		setError(null);
		setModels(body.models ?? []);
	}, []);

	const load = useCallback(() => fetch("/api/speech-models").catch(() => null).then(apply), [apply]);

	useEffect(() => {
		void load();
	}, [load]);

	// Follow a download while one runs.
	const busy = models?.some((m) => m.state === "downloading" || m.state === "waiting") ?? false;
	useEffect(() => {
		if (!busy) return;
		const timer = setInterval(() => void load(), 2000);
		return () => clearInterval(timer);
	}, [busy, load]);

	if (models === null) return null;

	async function change(id: string, method: "POST" | "DELETE") {
		await apply(await fetch(`/api/speech-models/${id}`, { method }).catch(() => null));
		notifySettingsSaved("speech");
	}

	return (
		<SettingsGroup label="On-device speech" testid={`group-on-device-speech-${part}`}>
			{models.filter((model) => (model.kind === "dictation") === (part === "dictation")).map((model) => (
				<div key={model.id} className="flex items-center justify-between gap-3 px-1 py-1.5" data-testid={`speech-model-${model.id}`}>
					<span className="min-w-0 flex-1">
						<span className="block font-ui text-xs text-foreground">{modelName(model)}</span>
						<span className="block truncate font-mono text-[11px] text-muted-foreground">
							{model.label} · {modelStateLine(model)}
						</span>
					</span>
					{model.state === "ready" ? (
						<button
							type="button"
							onClick={() => void change(model.id, "DELETE")}
							data-testid={`speech-model-remove-${model.id}`}
							className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
						>
							Remove
						</button>
					) : model.state === "missing" || model.state === "failed" ? (
						<button
							type="button"
							onClick={() => void change(model.id, "POST")}
							data-testid={`speech-model-download-${model.id}`}
							className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline"
						>
							Download
						</button>
					) : null}
				</div>
			))}
			{part === "dictation" ? <BenchmarkRow /> : <NpuSpeechRow />}
			<p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
				{part === "dictation"
					? "Models download over Wi-Fi only and run on this phone. Dictation recognizes German and English by itself."
					: "Models download over Wi-Fi only and run on this phone. Read-aloud uses the voice of the language chosen below."}
			</p>
			{error && (
				<p role="alert" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</SettingsGroup>
	);
}
