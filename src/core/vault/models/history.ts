// History restore (#34, ADR 0010). Two flows. One document: list its versions, confirm one.
// Whole vault: pick a time, preview what would change, add back or be removed, then confirm.
// A restore is a forward write; history is never rewritten.

import type { HistoryVersionDto, RestorePlanDto } from "../contract.ts";
import { formatBytes, formatDateTime } from "../format.ts";
import { strings } from "../strings.ts";

interface Common {
	busy: boolean;
	error?: string;
}

export interface HistoryState {
	/** Retention window of the account, from AccountResponse.historyRetentionDays. */
	retentionDays: number;
	doc: ({ path: string; versions: HistoryVersionDto[] | null; confirmSeq: number | null } & Common);
	vault: ({ at: string; plan: RestorePlanDto[] | null; confirming: boolean; restored: number | null } & Common);
	/** Documents restored by the last single-document restore. */
	restoredDoc: string | null;
}

export type HistoryEvent =
	| { type: "path_changed"; path: string }
	| { type: "load_versions" }
	| { type: "versions_loaded"; versions: HistoryVersionDto[] }
	| { type: "ask_restore_version"; seq: number }
	| { type: "cancel_restore_version" }
	| { type: "restore_version" }
	| { type: "version_restored" }
	| { type: "at_changed"; at: string }
	| { type: "preview" }
	| { type: "previewed"; plan: RestorePlanDto[] }
	| { type: "ask_restore_all" }
	| { type: "cancel_restore_all" }
	| { type: "restore_all" }
	| { type: "all_restored"; plan: RestorePlanDto[] }
	| { type: "failed"; area: "doc" | "vault"; code: string };

export function initialHistory(retentionDays = 90): HistoryState {
	return {
		retentionDays,
		doc: { path: "", versions: null, confirmSeq: null, busy: false },
		vault: { at: "", plan: null, confirming: false, restored: null, busy: false },
		restoredDoc: null,
	};
}

/** Is `at` (datetime-local or ISO) a valid time in the past and inside the retention window? */
export function validRestoreTime(at: string, now: Date, retentionDays: number): boolean {
	const t = Date.parse(at);
	if (Number.isNaN(t)) return false;
	return t < now.getTime() && t >= now.getTime() - retentionDays * 86_400_000;
}

export function reduceHistory(s: HistoryState, e: HistoryEvent): HistoryState {
	switch (e.type) {
		case "failed":
			return e.area === "doc" ? { ...s, doc: { ...s.doc, busy: false, error: e.code } } : { ...s, vault: { ...s.vault, busy: false, error: e.code } };
		case "path_changed":
			return { ...s, restoredDoc: null, doc: { path: e.path, versions: null, confirmSeq: null, busy: false } };
		case "load_versions":
			return s.doc.path.trim() && !s.doc.busy ? { ...s, doc: { ...s.doc, busy: true, error: undefined } } : s;
		case "versions_loaded":
			return { ...s, doc: { ...s.doc, versions: e.versions, busy: false } };
		case "ask_restore_version":
			return s.doc.versions?.some((v) => v.seq === e.seq) ? { ...s, doc: { ...s.doc, confirmSeq: e.seq } } : s;
		case "cancel_restore_version":
			return { ...s, doc: { ...s.doc, confirmSeq: null } };
		case "restore_version":
			return s.doc.confirmSeq !== null && !s.doc.busy ? { ...s, doc: { ...s.doc, busy: true, error: undefined } } : s;
		case "version_restored":
			return { ...s, restoredDoc: s.doc.path, doc: { ...s.doc, confirmSeq: null, busy: false, versions: null } };
		case "at_changed":
			return { ...s, vault: { at: e.at, plan: null, confirming: false, restored: null, busy: false } };
		case "preview":
			return s.vault.at && !s.vault.busy ? { ...s, vault: { ...s.vault, busy: true, error: undefined, plan: null, restored: null } } : s;
		case "previewed":
			return { ...s, vault: { ...s.vault, plan: e.plan, busy: false } };
		case "ask_restore_all":
			return s.vault.plan && s.vault.plan.length > 0 ? { ...s, vault: { ...s.vault, confirming: true } } : s;
		case "cancel_restore_all":
			return { ...s, vault: { ...s.vault, confirming: false } };
		case "restore_all":
			return s.vault.confirming && !s.vault.busy ? { ...s, vault: { ...s.vault, busy: true, error: undefined } } : s;
		case "all_restored":
			return { ...s, vault: { ...s.vault, busy: false, confirming: false, plan: null, restored: e.plan.length } };
	}
}

export interface PlanGroups {
	changed: RestorePlanDto[];
	added: RestorePlanDto[];
	removed: RestorePlanDto[];
	summary: string;
	empty: boolean;
}

export function planGroups(plan: RestorePlanDto[]): PlanGroups {
	const changed = plan.filter((p) => p.change === "changed");
	const added = plan.filter((p) => p.change === "added");
	const removed = plan.filter((p) => p.change === "removed");
	return { changed, added, removed, summary: plan.length ? strings.history.previewSummary(changed.length, added.length, removed.length) : strings.history.previewEmpty, empty: plan.length === 0 };
}

export interface VersionView {
	seq: number;
	line: string;
	size: string;
	deleted: boolean;
}

export function versionViews(versions: HistoryVersionDto[]): VersionView[] {
	return versions.map((v) => ({
		seq: v.seq,
		line: strings.history.versionLine(formatDateTime(v.createdAt), v.deviceName),
		size: v.deleted ? strings.history.versionDeleted : formatBytes(v.size),
		deleted: v.deleted,
	}));
}
