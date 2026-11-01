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
import { SPEECH_LANGUAGE_LABEL, isSpeechLanguage, type OnDeviceModel } from "@/src/core";
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

function modelName(model: OnDeviceModel): string {
	if (model.kind === "dictation") return "Dictation";
	const language = isSpeechLanguage(model.language) ? SPEECH_LANGUAGE_LABEL[model.language] : model.language;
	return `Read-aloud voice · ${language}`;
}

/** The group, or nothing while the speech server is not an on-device one. */
export function OnDeviceSpeechGroup() {
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
		<SettingsGroup label="On-device speech" testid="group-on-device-speech">
			{models.map((model) => (
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
			<p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
				Models download over Wi-Fi only and run on this phone. Dictation recognizes German and English by itself; read-aloud uses the voice of the language chosen under Read aloud.
			</p>
			{error && (
				<p role="alert" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</SettingsGroup>
	);
}
