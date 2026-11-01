// Sync status banner (#35, ADR 0007): every SyncState with plain text, the number of changes
// waiting, and the last successful sync.

import type { SyncStatus } from "../deps.ts";
import { relativeTime } from "../format.ts";
import { strings } from "../strings.ts";

export type BannerTone = "ok" | "info" | "warning" | "error";
export type BannerAction = "unlock" | "sign_in" | "manage_plan" | null;

export interface SyncBanner {
	/** Quiet states (idle) render as a small status line, the rest as a banner. */
	level: "line" | "banner";
	tone: BannerTone;
	title: string;
	body: string;
	/** Short secondary facts: pending changes, last sync, conflicts. */
	facts: string[];
	action: BannerAction;
	actionLabel: string | null;
	/** True when changes are not leaving this device. */
	blocked: boolean;
}

export interface BannerOptions {
	now: Date;
	/** "Manage plan" is offered for quota and read-only states only when billing is enabled. */
	billingEnabled: boolean;
}

export function syncBanner(s: SyncStatus, o: BannerOptions): SyncBanner {
	const facts: string[] = [];
	if (s.pendingChanges > 0) facts.push(strings.sync.pending(s.pendingChanges));
	facts.push(s.lastSuccess ? strings.sync.lastSync(relativeTime(s.lastSuccess, o.now)) : strings.sync.neverSynced);
	if (s.conflicts > 0) facts.push(strings.sync.conflicts(s.conflicts));
	if (s.rejected > 0) facts.push(strings.sync.rejected(s.rejected));
	const base = { facts, action: null as BannerAction, actionLabel: null as string | null, blocked: false };
	const plan = o.billingEnabled ? { action: "manage_plan" as const, actionLabel: strings.sync.managePlan } : {};
	switch (s.state) {
		case "idle":
			return { ...base, level: "line", tone: "ok", title: s.lastSuccess ? strings.sync.idleAt(relativeTime(s.lastSuccess, o.now)) : strings.sync.idleNever, body: "" };
		case "syncing":
			return { ...base, level: "line", tone: "info", title: strings.sync.syncing, body: "" };
		case "offline":
			return { ...base, level: "banner", tone: "info", title: strings.sync.offlineTitle, body: strings.sync.offlineBody };
		case "error":
			return { ...base, level: "banner", tone: "error", title: strings.sync.errorTitle, body: s.error ? `${strings.sync.errorBody} (${s.error})` : strings.sync.errorBody };
		case "over_quota":
			return { ...base, ...plan, level: "banner", tone: "warning", title: strings.sync.overQuotaTitle, body: strings.sync.overQuotaBody, blocked: true };
		case "read_only":
			return { ...base, ...plan, level: "banner", tone: "warning", title: strings.sync.readOnlyTitle, body: strings.sync.readOnlyBody, blocked: true };
		case "rotation_rejected":
			return { ...base, action: "sign_in", actionLabel: strings.sync.signIn, level: "banner", tone: "error", title: strings.sync.rotationRejectedTitle, body: strings.sync.rotationRejectedBody, blocked: true };
		case "revoked":
			return { ...base, action: "sign_in", actionLabel: strings.sync.signIn, level: "banner", tone: "error", title: strings.sync.revokedTitle, body: strings.sync.revokedBody, blocked: true };
		case "needs_unlock":
			return { ...base, action: "unlock", actionLabel: strings.sync.unlock, level: "banner", tone: "warning", title: strings.sync.needsUnlockTitle, body: strings.sync.needsUnlockBody, blocked: true };
	}
}
