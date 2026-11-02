// The shapes of the vault client's API responses that the view models and routes use. The client
// package is a private optional dependency (ADR 0001 in the vault repo), so the public repo declares these
// DTOs itself instead of importing types from it; src/server/vault/compat.ts proves at compile
// time, when the package is installed, that the real client still produces them.

export interface PendingAction {
	id: string;
	kind: "revoke_device" | "regenerate_recovery_key" | "regenerate_backup_codes";
	strength: "password" | "passkey" | "recovery";
	requestedBy: string | null;
	requestedByName: string;
	targetDeviceId: string | null;
	runsAt: string;
	createdAt: string;
	cancellable: boolean;
}

export interface AccountResponse {
	accountId: string;
	email: string;
	state: "new" | "active" | "past_due" | "read_only" | "deleted";
	canPush: boolean;
	billingEnabled: boolean;
	trialEndsAt: string;
	graceEndsAt: string | null;
	quotaBytes: number;
	usedBytes: number;
	historyBytes: number;
	generation: number;
	epoch: number;
	lastExportAt: string | null;
	createdAt: string;
	backupCodesLeft: number;
	passkeys: number;
	devices: number;
	pendingAction: PendingAction | null;
	historyRetentionDays: number;
}

export interface DeviceRow {
	id: string;
	lhDeviceId: string;
	name: string;
	ephemeral: boolean;
	keysProtected: boolean;
	createdAt: string;
	lastSeenAt: string;
	current: boolean;
	established: boolean;
	hasUnlockMethod: boolean;
}

/** What the learner must see exactly once after sign-up: the emergency kit (never uploaded). */
export interface EmergencyKit {
	email: string;
	serverUrl: string;
	recoveryKey: string;
	/** QR payload for the recovery key. */
	recoveryKeyQr: string;
	createdAt: string;
}

export type SyncState = "idle" | "syncing" | "offline" | "error" | "over_quota" | "read_only" | "rotation_rejected" | "revoked" | "needs_unlock";

export interface SyncStatus {
	state: SyncState;
	pendingChanges: number;
	lastSuccess: string | null;
	error?: string;
	conflicts: number;
	rollbacks: number;
	/** Changes the server offered that were refused (bad path, not a synced document). */
	rejected: number;
}

export interface Version {
	seq: number;
	createdAt: string;
	deviceName: string;
	deleted: boolean;
	size: number;
}

/** One line of a restore plan, as the UI shows it. */
export interface RestorePlanEntry {
	path: string;
	change: "changed" | "added" | "removed";
}
