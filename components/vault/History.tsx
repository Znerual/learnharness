"use client";

import { useReducer, type Dispatch } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { formatDateTime } from "@/src/core";
import { initialHistory, planGroups, reduceHistory, validRestoreTime, versionViews, type HistoryEvent, type HistoryState } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Field, Notice, TextInput } from "./ui.tsx";

export interface HistoryActions {
	loadVersions(): void;
	restoreVersion(): void;
	preview(): void;
	restoreAll(): void;
}

export function HistoryView({ state, dispatch, actions, now }: { state: HistoryState; dispatch: Dispatch<HistoryEvent>; actions: HistoryActions; now: Date }) {
	const versions = state.doc.versions ? versionViews(state.doc.versions) : null;
	const groups = state.vault.plan ? planGroups(state.vault.plan) : null;
	const confirmVersion = state.doc.confirmSeq !== null ? state.doc.versions?.find((v) => v.seq === state.doc.confirmSeq) : undefined;
	const timeOk = validRestoreTime(state.vault.at, now, state.retentionDays);
	return (
		<section data-testid="history" className="flex flex-col gap-6">
			<header>
				<h2 className="text-lg font-semibold">{strings.history.title}</h2>
				<p className="text-sm">{strings.history.keptFor(state.retentionDays)}</p>
				<p className="text-sm text-muted-foreground">{strings.history.help}</p>
			</header>

			<div data-testid="history-document" className="flex flex-col gap-3">
				<h3 className="text-sm font-semibold">{strings.history.documentTitle}</h3>
				<Field label={strings.history.pathLabel}>
					<TextInput className="font-mono" value={state.doc.path} onChange={(e) => dispatch({ type: "path_changed", path: e.target.value })} />
				</Field>
				<div>
					<Button variant="secondary" disabled={state.doc.busy || !state.doc.path.trim()} onClick={actions.loadVersions}>
						{strings.history.loadVersions}
					</Button>
				</div>
				{state.restoredDoc ? <Notice tone="ok">{strings.history.restored(1)}</Notice> : null}
				{versions && versions.length === 0 ? <p className="text-sm">{strings.history.noVersions}</p> : null}
				{versions && versions.length > 0 ? (
					<ul className="flex flex-col gap-2">
						{versions.map((v) => (
							<li key={v.seq} data-testid="version" className="flex items-center justify-between gap-2 text-sm">
								<span>
									{v.line} <span className="text-muted-foreground">({v.size})</span>
								</span>
								<Button variant="link" onClick={() => dispatch({ type: "ask_restore_version", seq: v.seq })}>
									{strings.history.restoreVersion}
								</Button>
							</li>
						))}
					</ul>
				) : null}
				{confirmVersion ? (
					<Notice tone="warning" testid="restore-version-confirm">
						<p>{strings.history.restoreVersionConfirm(state.doc.path, formatDateTime(confirmVersion.createdAt))}</p>
						<div className="mt-2 flex gap-2">
							<Button disabled={state.doc.busy} onClick={actions.restoreVersion}>
								{state.doc.busy ? strings.common.working : strings.history.restoreVersion}
							</Button>
							<Button variant="secondary" onClick={() => dispatch({ type: "cancel_restore_version" })}>
								{strings.common.cancel}
							</Button>
						</div>
					</Notice>
				) : null}
				<ErrorLine code={state.doc.error} />
			</div>

			<div data-testid="history-vault" className="flex flex-col gap-3">
				<h3 className="text-sm font-semibold">{strings.history.vaultTitle}</h3>
				<Field label={strings.history.atLabel} error={state.vault.at && !timeOk ? strings.history.invalidTime : undefined}>
					<TextInput type="datetime-local" value={state.vault.at} onChange={(e) => dispatch({ type: "at_changed", at: e.target.value })} />
				</Field>
				<div>
					<Button variant="secondary" disabled={state.vault.busy || !timeOk} onClick={actions.preview}>
						{state.vault.busy && !state.vault.confirming ? strings.common.working : strings.history.preview}
					</Button>
				</div>
				{groups ? (
					<div data-testid="restore-preview" className="flex flex-col gap-2">
						<p className="text-sm font-medium">{groups.summary}</p>
						{(
							[
								["changed", strings.history.changed, groups.changed],
								["added", strings.history.added, groups.added],
								["removed", strings.history.removed, groups.removed],
							] as const
						).map(([id, label, items]) =>
							items.length ? (
								<div key={id} data-group={id}>
									<p className="text-xs font-semibold">{label}</p>
									<ul className="font-mono text-xs">
										{items.map((p) => (
											<li key={p.path}>{p.path}</li>
										))}
									</ul>
								</div>
							) : null,
						)}
						{!groups.empty ? (
							<div>
								<Button disabled={state.vault.busy} onClick={() => dispatch({ type: "ask_restore_all" })}>
									{strings.history.restoreAll}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
				{state.vault.confirming && state.vault.plan ? (
					<Notice tone="warning" testid="restore-all-confirm">
						<p>{strings.history.restoreAllConfirm(state.vault.plan.length)}</p>
						<div className="mt-2 flex gap-2">
							<Button variant="danger" disabled={state.vault.busy} onClick={actions.restoreAll}>
								{state.vault.busy ? strings.common.working : strings.history.restoreAll}
							</Button>
							<Button variant="secondary" disabled={state.vault.busy} onClick={() => dispatch({ type: "cancel_restore_all" })}>
								{strings.common.cancel}
							</Button>
						</div>
					</Notice>
				) : null}
				{state.vault.restored !== null ? <Notice tone="ok">{strings.history.restored(state.vault.restored)}</Notice> : null}
				<ErrorLine code={state.vault.error} />
			</div>
		</section>
	);
}

/** History wired to the routes. `at` values from the datetime-local input are read as local time. */
export function History({ api, retentionDays = 90, now = () => new Date() }: { api: VaultApi; retentionDays?: number; now?: () => Date }) {
	const [state, dispatch] = useReducer(reduceHistory, retentionDays, initialHistory);
	const atIso = () => new Date(state.vault.at).toISOString();
	const actions: HistoryActions = {
		loadVersions() {
			dispatch({ type: "load_versions" });
			api.historyVersions({ path: state.doc.path.trim() })
				.then((r) => dispatch({ type: "versions_loaded", versions: r.versions }))
				.catch((e) => dispatch({ type: "failed", area: "doc", code: errorCode(e) }));
		},
		restoreVersion() {
			if (state.doc.confirmSeq === null) return;
			dispatch({ type: "restore_version" });
			api.historyRestoreVersion({ path: state.doc.path.trim(), seq: state.doc.confirmSeq })
				.then(() => dispatch({ type: "version_restored" }))
				.catch((e) => dispatch({ type: "failed", area: "doc", code: errorCode(e) }));
		},
		preview() {
			dispatch({ type: "preview" });
			api.historyPreview({ at: atIso() })
				.then((r) => dispatch({ type: "previewed", plan: r.plan }))
				.catch((e) => dispatch({ type: "failed", area: "vault", code: errorCode(e) }));
		},
		restoreAll() {
			dispatch({ type: "restore_all" });
			api.historyRestoreTo({ at: atIso() })
				.then((r) => dispatch({ type: "all_restored", plan: r.plan }))
				.catch((e) => dispatch({ type: "failed", area: "vault", code: errorCode(e) }));
		},
	};
	return <HistoryView state={state} dispatch={dispatch} actions={actions} now={now()} />;
}
