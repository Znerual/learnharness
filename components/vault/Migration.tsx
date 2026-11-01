"use client";

import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { errorCode, strings, type MergeReport, type MigrationStateDto, type MovedAsideDto, type VaultApi } from "@/src/core";
import { Button, ErrorLine, Notice } from "./ui.tsx";

/**
 * Before signing in: what this device's data folder holds, what the first sign-in will change (a
 * backup first), and, while Syncthing still shares the folder, the steps to leave it
 * (docs/vault-migration.md). Read-only apart from the one button that sets Syncthing's markers aside.
 */
export function MigrationCheckView({ state, busy, error, moved, onSetAside, onRecheck }: { state: MigrationStateDto; busy: boolean; error?: string | undefined; moved: boolean; onSetAside: () => void; onRecheck: () => void }) {
	const { report, syncthing } = state;
	if (report.layout === "empty" && !syncthing.needed) return null;
	const names = [...new Set(syncthing.markers.map((m) => m.name))].join(", ");
	const mine = syncthing.markers.every((m) => m.canSetAside);
	return (
		<section data-testid="migration-check" className="flex flex-col gap-3">
			{syncthing.needed ? (
				<Notice tone="warning" title={strings.migration.syncthingTitle} testid="syncthing-guide">
					<p>{strings.migration.syncthingHelp}</p>
					<ol className="mt-1 list-decimal pl-5">
						{syncthing.steps.map((s) => (
							<li key={s}>{s}</li>
						))}
					</ol>
					<p className="mt-1 text-xs text-muted-foreground">{strings.migration.syncthingFound(names)}</p>
					{mine ? null : <p className="mt-1">{strings.migration.syncthingOutside}</p>}
					<div className="mt-2 flex gap-2">
						{mine ? (
							<Button disabled={busy} onClick={onSetAside}>
								{strings.migration.syncthingDone}
							</Button>
						) : null}
						<Button variant="secondary" disabled={busy} onClick={onRecheck}>
							{strings.migration.syncthingRecheck}
						</Button>
					</div>
				</Notice>
			) : moved ? (
				<Notice tone="ok" testid="syncthing-moved">
					{strings.migration.syncthingMoved}
				</Notice>
			) : null}
			{report.layout !== "empty" ? (
				<Notice tone={report.blocked ? "error" : "info"} title={strings.migration.dataTitle} testid="migration-data">
					<p>{strings.migration.counts(report.counts)}</p>
					{report.blocked ? <p>{strings.migration.blocked}</p> : report.needed ? <p>{strings.migration.willChange}</p> : <p>{strings.migration.ready}</p>}
					{report.needed && !report.blocked ? (
						<ul className="mt-1 list-disc pl-5">
							{report.steps
								.filter((s) => s.id !== "backup")
								.map((s) => (
									<li key={s.id}>
										{s.title} ({s.files})
									</li>
								))}
						</ul>
					) : null}
					{report.counts.conflicts > 0 ? <p className="mt-1">{strings.migration.conflictsNote(report.counts.conflicts)}</p> : null}
					{report.unreadable.length > 0 ? <p className="mt-1">{strings.migration.unreadable(report.unreadable.length)}</p> : null}
					{state.lastUpgrade ? <p className="mt-1 text-xs text-muted-foreground">{strings.migration.backupAt(state.lastUpgrade.backupDir)}</p> : null}
				</Notice>
			) : null}
			<ErrorLine code={error} />
		</section>
	);
}

/** The check wired to the routes. Renders nothing while loading, when there is no data and no Syncthing, or when the routes are missing. */
export function MigrationCheck({ api }: { api: VaultApi }) {
	const [state, setState] = useState<MigrationStateDto | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [moved, setMoved] = useState(false);
	const load = useCallback(() => {
		api.migrationReport()
			.then((s) => {
				setState(s);
				setError(undefined);
			})
			.catch(() => setState(null));
	}, [api]);
	useEffect(load, [load]);
	if (!state) return null;
	return (
		<MigrationCheckView
			state={state}
			busy={busy}
			error={error}
			moved={moved}
			onRecheck={load}
			onSetAside={() => {
				setBusy(true);
				api.migrationSyncthingSetAside({ confirmed: true })
					.then(() => setMoved(true))
					.catch((e) => setError(errorCode(e)))
					.finally(() => {
						setBusy(false);
						load();
					});
			}}
		/>
	);
}

/** Moved-aside folders of this device, each with a button that merges it into the vault. */
export function MovedAsideView({ folders, busy, done, error, onMerge }: { folders: MovedAsideDto[]; busy: string | null; done: Record<string, MergeReport>; error?: string | undefined; onMerge: (name: string) => void }) {
	if (folders.length === 0) return null;
	return (
		<section data-testid="moved-aside" className="flex flex-col gap-2">
			<p className="text-sm">{strings.migration.asideHelp}</p>
			{folders.map((f) => {
				const r = done[f.name];
				return (
					<div key={f.name} data-testid="moved-aside-folder" className="flex flex-wrap items-center gap-2 text-sm">
						<span>{strings.migration.aside(f)}</span>
						{r ? (
							<span data-testid="merge-result">{strings.migration.mergeResult({ sessions: r.sessions.added + r.sessions.continued, conflicts: r.sessions.conflictCopies, graph: r.graphLines.added })}</span>
						) : (
							<Button variant="secondary" disabled={busy !== null} onClick={() => onMerge(f.name)}>
								{busy === f.name ? strings.migration.merging : f.merged ? strings.migration.merged : strings.migration.merge}
							</Button>
						)}
					</div>
				);
			})}
			<ErrorLine code={error} />
		</section>
	);
}

/** `Group` is the settings dialog's group frame; it is only rendered when there is something to show. */
export function MovedAside({ api, Group }: { api: VaultApi; Group: ComponentType<{ label: string; children: ReactNode }> }) {
	const [folders, setFolders] = useState<MovedAsideDto[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [done, setDone] = useState<Record<string, MergeReport>>({});
	const [error, setError] = useState<string | undefined>();
	useEffect(() => {
		api.migrationReport()
			.then((s) => setFolders(s.movedAside))
			.catch(() => setFolders([]));
	}, [api]);
	if (folders.length === 0) return null;
	return (
		<Group label={strings.migration.asideTitle}>
			<MovedAsideView
				folders={folders}
				busy={busy}
				done={done}
				error={error}
				onMerge={(name) => {
					setBusy(name);
					setError(undefined);
					api.migrationMerge({ name })
						.then((r) => setDone((d) => ({ ...d, [name]: r })))
						.catch((e) => setError(errorCode(e)))
						.finally(() => setBusy(null));
				}}
			/>
		</Group>
	);
}
