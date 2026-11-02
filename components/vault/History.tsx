"use client";

import { useMemo, useReducer, useState, type Dispatch } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { formatDateTime } from "@/src/core";
import { filterDocuments, initialHistory, planGroups, reduceHistory, validRestoreTime, versionViews, type HistoryDocumentDto, type HistoryEvent, type HistoryState } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Field, Notice, TextInput } from "./ui.tsx";

export interface HistoryActions {
	/** Opens the document picker. */
	chooseDocument(): void;
	loadVersions(): void;
	restoreVersion(): void;
	preview(): void;
	restoreAll(): void;
}

export function HistoryView({ state, dispatch, actions, now, docTitle }: { state: HistoryState; dispatch: Dispatch<HistoryEvent>; actions: HistoryActions; now: Date; docTitle?: string | null }) {
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
				<div data-testid="history-chosen" className="flex flex-col gap-1 text-sm">
					<span className="font-medium">{strings.history.pathLabel}</span>
					{state.doc.path ? (
						<span>
							{docTitle ?? state.doc.path}
							{docTitle ? <span className="block font-mono text-xs text-muted-foreground">{state.doc.path}</span> : null}
						</span>
					) : (
						<span className="text-muted-foreground">{strings.history.noDocumentChosen}</span>
					)}
				</div>
				<div>
					<Button variant="secondary" disabled={state.doc.busy} onClick={actions.chooseDocument}>
						{state.doc.path ? strings.history.changeDocument : strings.history.chooseDocument}
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

const KIND_LABEL: Record<HistoryDocumentDto["kind"], string> = { chat: strings.history.kindChat, job: strings.history.kindJob, other: strings.history.kindOther };

/** The document picker: a modal list of the restorable documents with a search field. */
export function DocumentPickerView({ documents, query, onQuery, onPick, onClose }: { documents: HistoryDocumentDto[] | null; query: string; onQuery: (q: string) => void; onPick: (d: HistoryDocumentDto) => void; onClose: () => void }) {
	const shown = useMemo(() => (documents ? filterDocuments(documents, query) : null), [documents, query]);
	return (
		<div
			data-testid="document-picker"
			role="dialog"
			aria-modal="true"
			aria-label={strings.history.pickerTitle}
			className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 sm:items-center"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-lg">
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-base font-semibold">{strings.history.pickerTitle}</h3>
					<Button variant="link" onClick={onClose}>
						{strings.common.cancel}
					</Button>
				</div>
				<TextInput autoFocus type="search" aria-label={strings.history.pickerSearch} placeholder={strings.history.pickerSearch} value={query} onChange={(e) => onQuery(e.target.value)} />
				<div className="min-h-0 flex-1 overflow-y-auto">
					{shown === null ? <p className="text-sm">{strings.history.pickerLoading}</p> : null}
					{shown && shown.length === 0 ? <p className="text-sm">{documents?.length ? strings.history.pickerEmpty : strings.history.pickerNone}</p> : null}
					{shown && shown.length > 0 ? (
						<ul className="flex flex-col">
							{shown.map((d) => (
								<li key={d.path}>
									<button type="button" data-testid="document-option" className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => onPick(d)}>
										<span className="text-sm">{d.title}</span>
										<span className="text-xs text-muted-foreground">
											{KIND_LABEL[d.kind]}
											{d.updatedAt ? ` · ${formatDateTime(d.updatedAt)}` : ""}
										</span>
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
				<p className="text-xs text-muted-foreground">{strings.history.pickerHelp}</p>
			</div>
		</div>
	);
}

/** History wired to the routes. `at` values from the datetime-local input are read as local time. */
export function History({ api, retentionDays = 90, now = () => new Date() }: { api: VaultApi; retentionDays?: number; now?: () => Date }) {
	const [state, dispatch] = useReducer(reduceHistory, retentionDays, initialHistory);
	const [picker, setPicker] = useState<{ documents: HistoryDocumentDto[] | null; query: string } | null>(null);
	const [docTitle, setDocTitle] = useState<string | null>(null);
	const atIso = () => new Date(state.vault.at).toISOString();
	const load = (path: string) => {
		dispatch({ type: "load_versions" });
		api.historyVersions({ path })
			.then((r) => dispatch({ type: "versions_loaded", versions: r.versions }))
			.catch((e) => dispatch({ type: "failed", area: "doc", code: errorCode(e) }));
	};
	const actions: HistoryActions = {
		chooseDocument() {
			setPicker({ documents: null, query: "" });
			api.historyDocuments()
				.then((r) => setPicker((p) => (p ? { ...p, documents: r.documents } : p)))
				.catch((e) => {
					setPicker(null);
					dispatch({ type: "failed", area: "doc", code: errorCode(e) });
				});
		},
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
	return (
		<>
			<HistoryView state={state} dispatch={dispatch} actions={actions} now={now()} docTitle={docTitle} />
			{picker ? (
				<DocumentPickerView
					documents={picker.documents}
					query={picker.query}
					onQuery={(query) => setPicker((p) => (p ? { ...p, query } : p))}
					onClose={() => setPicker(null)}
					onPick={(d) => {
						setPicker(null);
						setDocTitle(d.title);
						dispatch({ type: "path_changed", path: d.path });
						load(d.path);
					}}
				/>
			) : null}
		</>
	);
}
