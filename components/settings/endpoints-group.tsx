"use client";
/**
 * The Keys section's CUSTOM ENDPOINTS group (custom-endpoints wave, owner
 * 2026-10-24): user-added OpenAI-compatible servers (vLLM, LM Studio,
 * Ollama, …). Same minimal table look as the key rows — name left, a
 * one-line status right; clicking a row unfolds its editor beneath, and
 * the last row adds a new endpoint.
 *
 * The editor: name (the id derives from it on create and is fixed after),
 * base URL, an OPTIONAL key, the thinking format (how on/off reaches the
 * server), Detect models (POST /api/endpoints/detect), and a per-model
 * override table over the detected values. Save writes the endpoints
 * settings section (PUT /api/settings/endpoints — replace-whole) and, when
 * a key was pasted, the key (PUT /api/keys/LH_ENDPOINT_<ID>_KEY). The
 * detected list is persisted (owner ruling), so slots stay valid while a
 * backend is down; Detect again to refresh it.
 */

import { useEffect, useState } from "react";
import {
	DEFAULT_ENDPOINT_THINKING_FORMAT,
	ENDPOINT_THINKING_FORMAT_LABEL,
	ENDPOINT_THINKING_FORMATS,
	effectiveModelValues,
	endpointKeyVar,
	isValidEndpointId,
	mergeDetectedModels,
	normalizeBaseUrl,
	slugifyEndpointName,
	type AuthKeyStatus,
	type CustomEndpoint,
	type EndpointModel,
	type EndpointModelValues,
	type EndpointThinkingFormat,
	type UserSettings,
} from "@/src/core";
import { SettingsGroup } from "./controls.tsx";
import { keyStatusLine } from "./keys-section.tsx";

const INPUT_CLASS =
	"h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const LINK_BUTTON =
	"shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const MUTED_BUTTON =
	"shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

/** The row's status line, e.g. "10.0.0.5:8012 · 3 models · key". Pure —
 *  exported for tests. */
export function endpointStatusLine(endpoint: CustomEndpoint, keyStatus: AuthKeyStatus | undefined): string {
	let host = endpoint.baseUrl;
	try {
		host = new URL(endpoint.baseUrl).host;
	} catch {
		// stored URLs are normalized; the raw string is the fallback
	}
	const count = `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}`;
	return `${host} · ${count} · ${keyStatus?.present ? "key" : "no key"}`;
}

/** Apply one edited value to a model: equal to the detected value clears
 *  the override, anything else sets it. Pure — exported for tests. */
export function withOverride<K extends keyof EndpointModelValues>(
	model: EndpointModel,
	field: K,
	value: EndpointModelValues[K],
): EndpointModel {
	const overrides = { ...(model.overrides ?? {}) };
	if (value === model[field]) delete overrides[field];
	else overrides[field] = value;
	const { overrides: _old, ...rest } = model;
	return Object.keys(overrides).length ? { ...rest, overrides } : rest;
}

export function EndpointsGroup({
	keyStatuses,
	onKeysChanged,
}: {
	/** The Keys section's statuses — the endpoints' key rows live there. */
	keyStatuses: readonly AuthKeyStatus[];
	/** Re-read keys + announce the change (the section's reload). */
	onKeysChanged: () => Promise<void>;
}) {
	const [endpoints, setEndpoints] = useState<CustomEndpoint[] | null>(null);
	/** The unfolded editor: an endpoint id, "new", or null. */
	const [open, setOpen] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings: UserSettings | null }) => setEndpoints(body.settings?.endpoints?.list ?? []))
			.catch(() => setEndpoints([]));

	useEffect(() => {
		void reload();
	}, []);

	if (endpoints === null) return null;

	async function writeList(list: CustomEndpoint[]): Promise<string | null> {
		const res = await fetch("/api/settings/endpoints", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ list }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return body.error ?? `Save failed (${res.status})`;
		}
		return null;
	}

	async function save(endpoint: CustomEndpoint, key: string): Promise<string | null> {
		const list = endpoints!.some((e) => e.id === endpoint.id)
			? endpoints!.map((e) => (e.id === endpoint.id ? endpoint : e))
			: [...endpoints!, endpoint];
		const err = await writeList(list);
		if (err) return err;
		if (key.trim()) {
			const res = await fetch(`/api/keys/${endpointKeyVar(endpoint.id)}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: key }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				await reload();
				return `Endpoint saved, key rejected: ${body.error ?? res.status}`;
			}
		}
		await reload();
		await onKeysChanged();
		setOpen(null);
		return null;
	}

	async function remove(id: string): Promise<string | null> {
		const err = await writeList(endpoints!.filter((e) => e.id !== id));
		if (err) return err;
		await fetch(`/api/keys/${endpointKeyVar(id)}`, { method: "DELETE" }).catch(() => undefined);
		await reload();
		await onKeysChanged();
		setOpen(null);
		return null;
	}

	const statusFor = (id: string) => keyStatuses.find((s) => s.id === endpointKeyVar(id));

	return (
		<SettingsGroup label="Custom endpoints" testid="group-endpoints">
			{endpoints.map((endpoint) =>
				open === endpoint.id ? (
					<EndpointEditor
						key={endpoint.id}
						initial={endpoint}
						keyStatus={statusFor(endpoint.id)}
						takenIds={endpoints.map((e) => e.id).filter((id) => id !== endpoint.id)}
						onSave={save}
						onDelete={() => remove(endpoint.id)}
						onCancel={() => setOpen(null)}
					/>
				) : (
					<button
						key={endpoint.id}
						type="button"
						data-testid={`endpoint-${endpoint.id}-row`}
						onClick={() => setOpen(endpoint.id)}
						className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
					>
						<span className="font-ui text-xs text-foreground">{endpoint.name}</span>
						<span className="font-mono text-[11px] text-muted-foreground">
							{endpointStatusLine(endpoint, statusFor(endpoint.id))}
						</span>
					</button>
				),
			)}
			{open === "new" ? (
				<EndpointEditor
					initial={null}
					keyStatus={undefined}
					takenIds={endpoints.map((e) => e.id)}
					onSave={save}
					onCancel={() => setOpen(null)}
				/>
			) : (
				<button
					type="button"
					data-testid="add-endpoint"
					onClick={() => setOpen("new")}
					className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					<span>+ Add custom endpoint</span>
				</button>
			)}
		</SettingsGroup>
	);
}

/** The unfolded editor for one endpoint (initial null = a new one). */
function EndpointEditor({
	initial,
	keyStatus,
	takenIds,
	onSave,
	onDelete,
	onCancel,
}: {
	initial: CustomEndpoint | null;
	keyStatus: AuthKeyStatus | undefined;
	takenIds: string[];
	onSave: (endpoint: CustomEndpoint, key: string) => Promise<string | null>;
	onDelete?: () => Promise<string | null>;
	onCancel: () => void;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [key, setKey] = useState("");
	const [thinkingFormat, setThinkingFormat] = useState<EndpointThinkingFormat>(
		initial?.thinkingFormat ?? DEFAULT_ENDPOINT_THINKING_FORMAT,
	);
	const [models, setModels] = useState<EndpointModel[]>(initial?.models ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const id = initial?.id ?? slugifyEndpointName(name);
	const testid = `endpoint-${initial?.id ?? "new"}`;

	async function detect() {
		setBusy(true);
		setError(null);
		const res = await fetch("/api/endpoints/detect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ baseUrl, apiKey: key || undefined, endpointId: initial?.id }),
		}).catch(() => null);
		const body = (await res?.json().catch(() => ({}))) as { models?: EndpointModel[]; error?: string } | undefined;
		if (res?.ok && body?.models) setModels((prev) => mergeDetectedModels(prev, body.models!));
		else setError(body?.error ?? "Detection failed");
		setBusy(false);
	}

	async function save() {
		const url = normalizeBaseUrl(baseUrl);
		if (!name.trim()) return setError("Name is required");
		if (!isValidEndpointId(id)) return setError("The name must contain letters or digits");
		if (takenIds.includes(id)) return setError(`An endpoint with id "${id}" already exists`);
		if (!url) return setError("Base URL must be an http(s) URL, e.g. http://10.0.0.5:8000/v1");
		if (models.length === 0) return setError("Detect models before saving");
		setBusy(true);
		setError(null);
		const err = await onSave({ id, name: name.trim(), baseUrl: url, thinkingFormat, models }, key);
		if (err) setError(err);
		setBusy(false);
	}

	async function remove() {
		if (!onDelete) return;
		setBusy(true);
		const err = await onDelete();
		if (err) setError(err);
		setBusy(false);
	}

	const update = (index: number, next: EndpointModel) => setModels((prev) => prev.map((m, i) => (i === index ? next : m)));

	return (
		<div data-testid={`${testid}-editor`} className="flex flex-col gap-2 rounded-sm border border-border/60 p-2">
			<div className="grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
				<label className="font-ui text-muted-foreground" htmlFor={`${testid}-name`}>Name</label>
				<div className="flex items-center gap-2">
					<input
						id={`${testid}-name`}
						data-testid={`${testid}-name`}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="AIT vLLM"
						disabled={busy}
						autoFocus={!initial}
						className={`${INPUT_CLASS} flex-1 font-ui`}
					/>
					<span className="font-mono text-[11px] text-muted-foreground/70">{id ? `id ${id}` : ""}</span>
				</div>
				<label className="font-ui text-muted-foreground" htmlFor={`${testid}-url`}>Base URL</label>
				<input
					id={`${testid}-url`}
					data-testid={`${testid}-url`}
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="http://10.0.0.5:8000/v1"
					disabled={busy}
					className={INPUT_CLASS}
				/>
				<label className="font-ui text-muted-foreground" htmlFor={`${testid}-key`}>API key</label>
				<input
					id={`${testid}-key`}
					data-testid={`${testid}-key`}
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder={keyStatus?.present ? `${keyStatusLine(keyStatus)} — paste to replace` : "Optional"}
					disabled={busy}
					className={INPUT_CLASS}
				/>
				<label className="font-ui text-muted-foreground" htmlFor={`${testid}-thinking`}>Thinking</label>
				<select
					id={`${testid}-thinking`}
					data-testid={`${testid}-thinking`}
					value={thinkingFormat}
					onChange={(e) => setThinkingFormat(e.target.value as EndpointThinkingFormat)}
					disabled={busy}
					className={`${INPUT_CLASS} font-ui`}
				>
					{ENDPOINT_THINKING_FORMATS.map((f) => (
						<option key={f} value={f}>
							{ENDPOINT_THINKING_FORMAT_LABEL[f]}
						</option>
					))}
				</select>
			</div>

			<div className="flex items-center justify-between gap-2">
				<span className="font-ui text-xs text-muted-foreground">
					{models.length ? `${models.length} model${models.length === 1 ? "" : "s"}` : "No models detected yet"}
				</span>
				<button
					type="button"
					onClick={() => void detect()}
					disabled={busy || !baseUrl.trim()}
					data-testid={`${testid}-detect`}
					className={LINK_BUTTON}
				>
					{models.length ? "Detect again" : "Detect models"}
				</button>
			</div>

			{models.length > 0 && (
				<table data-testid={`${testid}-models`} className="w-full text-left font-mono text-[11px]">
					<thead className="text-muted-foreground">
						<tr>
							<th className="py-1 font-normal">model</th>
							<th className="w-20 py-1 font-normal">context</th>
							<th className="w-20 py-1 font-normal">max out</th>
							<th className="w-12 py-1 text-center font-normal">vision</th>
							<th className="w-14 py-1 text-center font-normal">thinking</th>
							<th className="w-6" />
						</tr>
					</thead>
					<tbody>
						{models.map((m, i) => {
							const v = effectiveModelValues(m);
							return (
								<tr key={m.id} data-testid={`${testid}-model-${i}`}>
									<td className="truncate py-0.5 pr-2 text-foreground" title={m.id}>{m.id}</td>
									{(["contextWindow", "maxTokens"] as const).map((field) => (
										<td key={field} className="py-0.5 pr-1">
											<input
												type="number"
												min={1}
												value={v[field]}
												disabled={busy}
												aria-label={`${m.id} ${field}`}
												onChange={(e) => {
													const n = Math.floor(Number(e.target.value));
													if (Number.isFinite(n) && n > 0) update(i, withOverride(m, field, n));
												}}
												className={`${INPUT_CLASS} h-6 w-full`}
											/>
										</td>
									))}
									{(["vision", "reasoning"] as const).map((field) => (
										<td key={field} className="py-0.5 text-center">
											<input
												type="checkbox"
												checked={v[field]}
												disabled={busy}
												aria-label={`${m.id} ${field}`}
												onChange={(e) => update(i, withOverride(m, field, e.target.checked))}
											/>
										</td>
									))}
									<td className="py-0.5 text-center">
										{m.overrides && (
											<button
												type="button"
												title="Reset to detected values"
												aria-label={`Reset ${m.id} to detected values`}
												onClick={() => update(i, { ...m, overrides: undefined })}
												className="text-muted-foreground hover:text-foreground"
											>
												↺
											</button>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}

			<div className="flex items-center justify-end gap-3">
				<button type="button" onClick={() => void save()} disabled={busy} data-testid={`${testid}-save`} className={LINK_BUTTON}>
					Save
				</button>
				<button type="button" onClick={onCancel} disabled={busy} data-testid={`${testid}-cancel`} className={MUTED_BUTTON}>
					Cancel
				</button>
				{onDelete && (
					<button
						type="button"
						onClick={() => void remove()}
						disabled={busy}
						data-testid={`${testid}-delete`}
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
					>
						Delete
					</button>
				)}
			</div>
			{error && (
				<p role="alert" data-testid={`${testid}-error`} className="text-xs text-red-500">
					{error}
				</p>
			)}
		</div>
	);
}
