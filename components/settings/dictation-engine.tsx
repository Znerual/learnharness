"use client";
/**
 * The dictation-engine rows of the Keys section's Dictation group
 * (local-STT wave, owner 2026-10-24): an explicit Deepgram | Local switch
 * and the local endpoint's base URL + model (click-unfold editor, the key
 * rows' look). The local endpoint's optional key is the curated
 * LH_STT_KEY row in the same group. Writes the `dictation` settings
 * section (PUT /api/settings/dictation, replace-whole).
 */

import { useEffect, useState } from "react";
import { normalizeBaseUrl, resolveDictation, type DictationEngine, type DictationSettings, type UserSettings } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

const INPUT_CLASS =
	"h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

/** The local row's status line. Pure — exported for tests. */
export function localSttStatusLine(section: DictationSettings | undefined): string {
	const { localUrl, localModel } = resolveDictation(section);
	if (!localUrl) return "not set";
	let host = localUrl;
	try {
		host = new URL(localUrl).host;
	} catch {
		// stored URLs are normalized; the raw string is the fallback
	}
	return localModel ? `${host} · ${localModel}` : host;
}

export function DictationEngineRows() {
	const [section, setSection] = useState<DictationSettings | null>(null);
	const [editing, setEditing] = useState(false);
	const [url, setUrl] = useState("");
	const [model, setModel] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings: UserSettings | null }) => setSection(body.settings?.dictation ?? {}))
			.catch(() => setSection({}));
	}, []);

	if (section === null) return null;
	const effective = resolveDictation(section);

	async function write(next: DictationSettings): Promise<boolean> {
		setError(null);
		const res = await fetch("/api/settings/dictation", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(next),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? `Save failed (${res.status})`);
			return false;
		}
		setSection(next);
		notifySettingsSaved("dictation");
		return true;
	}

	const pick = (engine: DictationEngine) => void write({ ...section, engine });

	async function saveLocal() {
		const trimmed = url.trim();
		if (trimmed && !normalizeBaseUrl(trimmed)) {
			setError("Base URL must be an http(s) URL, e.g. http://localhost:8110/v1");
			return;
		}
		const next: DictationSettings = { ...section, localUrl: trimmed || undefined, localModel: model.trim() || undefined };
		if (!next.localUrl) delete next.localUrl;
		if (!next.localModel) delete next.localModel;
		if (await write(next)) setEditing(false);
	}

	return (
		<>
			<div className="flex items-center justify-between gap-3 px-1 py-1.5 android:flex-col android:items-stretch android:gap-1.5" data-testid="dictation-engine-row">
				<span className="font-ui text-xs text-foreground">Dictation engine</span>
				<span className="flex items-center gap-1" role="radiogroup" aria-label="Dictation engine">
					{(["deepgram", "local"] as const).map((engine) => (
						<button
							key={engine}
							type="button"
							role="radio"
							aria-checked={effective.engine === engine}
							data-testid={`dictation-engine-${engine}`}
							onClick={() => pick(engine)}
							className={`rounded-sm px-2 py-0.5 font-ui text-xs transition-colors ${
								effective.engine === engine ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{engine === "deepgram" ? "Deepgram" : "Local"}
						</button>
					))}
				</span>
			</div>
			{editing ? (
				<div className="flex items-center gap-2 rounded-sm px-1 py-1.5" data-testid="local-stt-editor">
					<span className="shrink-0 font-ui text-xs text-foreground">Local speech-to-text</span>
					<input
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void saveLocal();
						}}
						placeholder="http://localhost:8000/v1"
						aria-label="Local speech-to-text base URL"
						data-testid="local-stt-url"
						autoFocus
						className={INPUT_CLASS}
					/>
					<input
						value={model}
						onChange={(e) => setModel(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void saveLocal();
						}}
						placeholder="model (optional)"
						aria-label="Local speech-to-text model"
						data-testid="local-stt-model"
						className={`${INPUT_CLASS} max-w-32`}
					/>
					<button
						type="button"
						onClick={() => void saveLocal()}
						data-testid="local-stt-save"
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
			) : (
				<button
					type="button"
					data-testid="local-stt-row"
					onClick={() => {
						setUrl(effective.localUrl ?? "");
						setModel(effective.localModel ?? "");
						setEditing(true);
					}}
					className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
				>
					<span className="font-ui text-xs text-foreground">Local speech-to-text</span>
					<span className="font-mono text-[11px] text-muted-foreground">{localSttStatusLine(section)}</span>
				</button>
			)}
			{error && (
				<p role="alert" data-testid="dictation-engine-error" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</>
	);
}
