"use client";

import { useEffect, useReducer, type Dispatch } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { AccountResponse } from "@/src/core";
import { exportReminder, initialExport, lastExportText, reduceExport, type ExportEvent, type ExportState } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Notice } from "./ui.tsx";

type AccountLike = Pick<AccountResponse, "lastExportAt" | "createdAt">;

/** Dismissable banner shown when the last export is more than 90 days old (ADR 0010, #11). */
export function ExportReminderView({ account, state, now, dispatch, onDownload, onTurnOff }: { account: AccountLike; state: ExportState; now: Date; dispatch: Dispatch<ExportEvent>; onDownload: () => void; onTurnOff: () => void }) {
	const r = exportReminder(account, state, now);
	if (!r.show) return null;
	return (
		<Notice tone="warning" title={r.title} testid="export-reminder">
			<p>{r.body}</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<Button disabled={state.status === "downloading"} onClick={onDownload}>
					{state.status === "downloading" ? strings.export.downloading : strings.export.reminderAction}
				</Button>
				<Button variant="secondary" onClick={() => dispatch({ type: "dismiss" })}>
					{strings.export.reminderDismiss}
				</Button>
				<Button variant="link" onClick={onTurnOff}>
					{strings.export.reminderOff}
				</Button>
			</div>
			<ErrorLine code={state.error} />
		</Notice>
	);
}

/** The Vault settings block: download, last export time, and the reminder setting. */
export function ExportSettingsView({ account, state, now, onDownload, onSetting }: { account: AccountLike; state: ExportState; now: Date; onDownload: () => void; onSetting: (enabled: boolean) => void }) {
	return (
		<section data-testid="export-settings" className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold">{strings.export.title}</h2>
			<p className="text-sm">{strings.export.help}</p>
			<p className="text-xs text-muted-foreground">{lastExportText(account, now)}</p>
			<div>
				<Button disabled={state.status === "downloading"} onClick={onDownload}>
					{state.status === "downloading" ? strings.export.downloading : strings.export.download}
				</Button>
			</div>
			{state.status === "done" ? <Notice tone="ok">{strings.export.downloaded}</Notice> : null}
			<ErrorLine code={state.status === "failed" ? "export_failed" : undefined} />
			<label className="flex items-start gap-2 text-sm">
				<input type="checkbox" checked={state.reminderEnabled} onChange={(e) => onSetting(e.target.checked)} />
				<span>
					{strings.export.settingLabel}
					<span className="block text-xs text-muted-foreground">{strings.export.settingHelp}</span>
				</span>
			</label>
		</section>
	);
}

/** Saves the export in the browser. The route returns base64; a streaming route is better for large vaults. */
export function saveBase64File(r: { filename: string; contentType: string; dataBase64: string }): void {
	const bytes = Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type: r.contentType }));
	const a = document.createElement("a");
	a.href = url;
	a.download = r.filename;
	a.click();
	URL.revokeObjectURL(url);
}

function useExport(api: VaultApi, onExported?: () => void): [ExportState, Dispatch<ExportEvent>, () => void, (enabled: boolean) => void] {
	const [state, dispatch] = useReducer(reduceExport, undefined, () => initialExport());
	useEffect(() => {
		api.exportReminderGet()
			.then((r) => dispatch({ type: "reminder_setting", enabled: r.enabled }))
			.catch(() => undefined);
	}, [api]);
	const download = () => {
		dispatch({ type: "download" });
		api.exportDownload()
			.then((r) => {
				saveBase64File(r);
				dispatch({ type: "downloaded" });
				onExported?.();
			})
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	};
	const setting = (enabled: boolean) => {
		dispatch({ type: "reminder_setting", enabled });
		void api.exportReminderSet({ enabled }).catch(() => undefined);
	};
	return [state, dispatch, download, setting];
}

/** Banner wired to the routes. Pass the account from `api.account()`; `onExported` should refresh it. */
export function ExportReminder({ api, account, now = () => new Date(), onExported }: { api: VaultApi; account: AccountLike; now?: () => Date; onExported?: () => void }) {
	const [state, dispatch, download, setting] = useExport(api, onExported);
	return <ExportReminderView account={account} state={state} now={now()} dispatch={dispatch} onDownload={download} onTurnOff={() => setting(false)} />;
}

export function ExportSettings({ api, account, now = () => new Date(), onExported }: { api: VaultApi; account: AccountLike; now?: () => Date; onExported?: () => void }) {
	const [state, , download, setting] = useExport(api, onExported);
	return <ExportSettingsView account={account} state={state} now={now()} onDownload={download} onSetting={setting} />;
}
