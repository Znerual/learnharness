// Export (ADR 0010) and the 90-day reminder (#11): a dismissable banner suggesting "Download
// export" when the last export from any device is more than 90 days old, with a setting to turn
// it off. The server records `lastExportAt` per account, so all devices agree.

import type { AccountResponse } from "../deps.ts";
import { daysBetween, relativeTime } from "../format.ts";
import { strings } from "../strings.ts";

export const EXPORT_REMINDER_DAYS = 90;

export interface ExportState {
	status: "idle" | "downloading" | "done" | "failed";
	error?: string;
	/** The setting "Remind me to export every 90 days". Default on. */
	reminderEnabled: boolean;
	/** "Remind me later" hides the banner until the app restarts. */
	dismissed: boolean;
}

export type ExportEvent =
	| { type: "download" }
	| { type: "downloaded" }
	| { type: "failed"; code: string }
	| { type: "dismiss" }
	| { type: "reminder_setting"; enabled: boolean };

export function initialExport(reminderEnabled = true): ExportState {
	return { status: "idle", reminderEnabled, dismissed: false };
}

export function reduceExport(s: ExportState, e: ExportEvent): ExportState {
	switch (e.type) {
		case "download":
			return s.status === "downloading" ? s : { ...s, status: "downloading", error: undefined };
		case "downloaded":
			// a fresh export resets the reminder for good: lastExportAt moves on the server
			return { ...s, status: "done", error: undefined, dismissed: true };
		case "failed":
			return { ...s, status: "failed", error: e.code };
		case "dismiss":
			return { ...s, dismissed: true };
		case "reminder_setting":
			return { ...s, reminderEnabled: e.enabled };
	}
}

export interface ReminderView {
	show: boolean;
	title: string;
	body: string;
	/** Whole days since the last export (or since the account was created if never). */
	days: number;
	never: boolean;
}

export function exportReminder(account: Pick<AccountResponse, "lastExportAt" | "createdAt">, s: ExportState, now: Date): ReminderView {
	const never = account.lastExportAt === null;
	const days = daysBetween(account.lastExportAt ?? account.createdAt, now);
	const due = days > EXPORT_REMINDER_DAYS;
	return {
		show: due && s.reminderEnabled && !s.dismissed,
		title: strings.export.reminderTitle,
		body: never ? strings.export.reminderNever : strings.export.reminderOld(days),
		days,
		never,
	};
}

export function lastExportText(account: Pick<AccountResponse, "lastExportAt">, now: Date): string {
	return account.lastExportAt ? strings.export.lastExport(relativeTime(account.lastExportAt, now)) : strings.export.neverExported;
}
