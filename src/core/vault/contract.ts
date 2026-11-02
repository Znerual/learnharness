// The server-route contract: one entry per UI action, with its HTTP method, path, request and
// response types. Types only plus the route table, so the renderer can import it without
// pulling in the vault client. The renderer never holds keys: every route runs in the
// LearnHarness server process, which owns the Vault object (see routes.ts).
//
// Paths are relative to a mount point (the fork mounts them at /api/vault). `:name` segments
// are filled from the request object; the rest of the request is the JSON body (or the query
// for GET).

import type { AccountResponse, DeviceRow, EmergencyKit, PendingAction, SyncStatus, Version } from "./deps.ts";
import type { PasswordCheckResult } from "./models/password.ts";
import type { JoinChoice, MergeReport, MigrationStateDto } from "./migration.ts";

export type * from "./migration.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Result of a rotation: done now, or waiting 24 h (ADR 0013). */
export type RotationDto = { status: "applied"; generation: number } | { status: "pending"; pendingAction: PendingAction };

export type ReauthStrength = "password" | "passkey" | "recovery";

/** What the server process knows about the session; the UI picks its start screen from it. */
export type SessionDto =
	| { state: "signed_out" }
	/** Signed in with a passkey that cannot unlock: pairing, password or recovery material needed. */
	| { state: "needs_unlock"; email: string }
	/** Recovery sign-in done; sync stays off until a new password is set. */
	| { state: "must_set_password" }
	/**
	 * Signed in, sync not started: a first start on this device waits for the learner. `localFiles` is the number of
	 * files this device holds that "Use the vault" would move aside (0: nothing to ask, only a chance to cancel).
	 */
	| { state: "joining"; email: string; localFiles: number }
	| { state: "signed_in"; accountId: string; deviceId: string; ephemeral: boolean; offline: boolean };

/** Why the passkey ceremony cannot run here: no bridge (web, dev, Android before 9), or a server whose host cannot be an RP id (http, port, IP address). */
export type PasskeyAvailabilityDto = { available: true } | { available: false; reason: "bridge_missing" | "unsupported_server" };

/** The account plus whether a passkey can be used for re-authentication on this device (it has one and the ceremony can run here). */
export type AccountDto = AccountResponse & { passkeyUsable: boolean };

export interface PasskeyRow {
	id: string;
	name: string;
	/** True when this passkey cannot unlock the data (no PRF): it signs in only. */
	signInOnly: boolean;
}

export interface OneTimeSecrets {
	recoveryKey: string;
	backupCodes: string[];
}

/** A document that Settings, History can restore by itself, with a readable title (GET /history/documents). */
export interface HistoryDocumentDto {
	path: string;
	kind: "chat" | "job" | "other";
	title: string;
	/** ISO time of the last change, when known. */
	updatedAt: string | null;
	/** Server-side only while listing. */
	chatId?: string | undefined;
}

export interface HistoryVersionDto {
	seq: number;
	createdAt: string;
	deviceName: string;
	deleted: boolean;
	size: number;
}

export interface RestorePlanDto {
	path: string;
	change: "changed" | "added" | "removed";
}

export interface Empty {}

export interface VaultContract {
	// session and launch
	session: { req: Empty; res: SessionDto };
	open: { req: Empty; res: SessionDto };
	signOut: { req: Empty; res: Empty };
	joinConfirm: { req: { choice: JoinChoice | "cancel" }; res: SessionDto };
	leaveVault: { req: { dryRun?: boolean }; res: { unpushed: number } };

	// sign-up
	passwordCheck: { req: { password: string }; res: PasswordCheckResult };
	signupStart: { req: { email: string }; res: Empty };
	signupVerify: { req: { email: string; code: string }; res: Empty };
	signupFinish: { req: { password: string }; res: { display: OneTimeSecrets; kit: EmergencyKit } };
	signupConfirm: { req: { typed: string }; res: { ok: boolean } };

	// sign-in, unlock, recovery
	signIn: { req: { email: string; password: string }; res: SessionDto };
	/** The whole ceremony runs in the server process and the Electron passkey window (ADR 0004); the credential and the PRF output never reach the renderer. */
	passkeySignIn: { req: { email: string }; res: SessionDto };
	unlockWithPassword: { req: { password: string }; res: SessionDto };
	recover: { req: { email: string; secret: string }; res: SessionDto };
	setNewPassword: { req: { password: string }; res: RotationDto };

	// re-authentication (ADR 0013); grants stay on the server, the UI holds a short handle
	reauthPassword: { req: { password: string }; res: { reauthId: string; strength: ReauthStrength } };
	reauthRecovery: { req: { secret: string }; res: { reauthId: string; strength: ReauthStrength } };
	reauthPasskey: { req: Empty; res: { reauthId: string; strength: ReauthStrength } };

	// account
	account: { req: Empty; res: AccountDto };
	changePassword: { req: { password: string; reauthId: string }; res: RotationDto };
	regenerateRecoveryKey: { req: { reauthId: string }; res: { rotation: RotationDto; recoveryKey: string; kit: EmergencyKit } };
	regenerateBackupCodes: { req: { reauthId: string }; res: { rotation: RotationDto; backupCodes: string[] } };
	managePlan: { req: Empty; res: { url: string } };
	deleteAccount: { req: { email: string; reauthId: string }; res: Empty };

	// passkeys
	passkeyAvailability: { req: Empty; res: PasskeyAvailabilityDto };
	passkeys: { req: Empty; res: { availability: PasskeyAvailabilityDto; passkeys: PasskeyRow[] } };
	passkeyRegister: { req: { name: string; reauthId: string }; res: PasskeyRow };
	passkeyRemove: { req: { passkeyId: string; reauthId: string }; res: RotationDto };

	// devices
	devices: { req: Empty; res: { devices: DeviceRow[]; pendingAction: PendingAction | null } };
	renameDevice: { req: { deviceId: string; name: string }; res: Empty };
	revokeDevice: { req: { deviceId: string; reauthId: string }; res: RotationDto };
	confirmPending: { req: { id: string; reauthId: string }; res: Empty };
	cancelPending: { req: { id: string; reauthId: string }; res: Empty };

	// pairing
	pairShow: { req: Empty; res: { pairingId: string; qr: string; text: string } };
	pairReview: { req: { pairingId: string }; res: { name: string; code: string } };
	pairApprove: { req: { pairingId: string }; res: Empty };
	/** Signed-in device scanned the code a new device shows; review and approve follow as usual. */
	pairApproverScan: { req: { code: string }; res: { pairingId: string } };
	pairCancel: { req: { pairingId: string }; res: Empty };
	pairJoinerShow: { req: Empty; res: { pairingId: string; qr: string; text: string; code: string } };
	pairJoin: { req: { code: string }; res: { pairingId: string; code: string } };
	pairFinish: { req: { pairingId: string }; res: SessionDto };

	// moving local data into the vault (docs/vault-migration.md); the first two work signed out
	migrationReport: { req: Empty; res: MigrationStateDto };
	/** After the learner removed the folder from Syncthing on every device: moves Syncthing's markers out of the way (nothing is deleted). */
	migrationSyncthingSetAside: { req: { confirmed: true }; res: { moved: string[]; remaining: string[] } };
	/** Merges a moved-aside `pre-vault-<date>` folder into the vault's data. Needs a running sync. */
	migrationMerge: { req: { name: string }; res: MergeReport };

	// sync
	syncStatus: { req: Empty; res: SyncStatus };
	syncNow: { req: Empty; res: SyncStatus };

	// history
	historyDocuments: { req: Empty; res: { documents: HistoryDocumentDto[] } };
	historyVersions: { req: { path: string }; res: { versions: HistoryVersionDto[] } };
	historyRestoreVersion: { req: { path: string; seq: number }; res: Empty };
	historyPreview: { req: { at: string }; res: { plan: RestorePlanDto[] } };
	historyRestoreTo: { req: { at: string }; res: { plan: RestorePlanDto[] } };

	// export
	exportDownload: { req: Empty; res: { filename: string; contentType: string; dataBase64: string } };
	exportReminderGet: { req: Empty; res: { enabled: boolean } };
	exportReminderSet: { req: { enabled: boolean }; res: { enabled: boolean } };
}

export type RouteName = keyof VaultContract;

export const routeTable: { [K in RouteName]: { method: HttpMethod; path: string } } = {
	session: { method: "GET", path: "/session" },
	open: { method: "POST", path: "/session/open" },
	signOut: { method: "POST", path: "/session/sign-out" },
	joinConfirm: { method: "POST", path: "/session/join" },
	leaveVault: { method: "POST", path: "/session/leave" },

	passwordCheck: { method: "POST", path: "/password/check" },
	signupStart: { method: "POST", path: "/signup/start" },
	signupVerify: { method: "POST", path: "/signup/verify" },
	signupFinish: { method: "POST", path: "/signup/finish" },
	signupConfirm: { method: "POST", path: "/signup/confirm" },

	signIn: { method: "POST", path: "/sign-in/password" },
	passkeySignIn: { method: "POST", path: "/sign-in/passkey" },
	unlockWithPassword: { method: "POST", path: "/unlock/password" },
	recover: { method: "POST", path: "/recover" },
	setNewPassword: { method: "POST", path: "/recover/new-password" },

	reauthPassword: { method: "POST", path: "/reauth/password" },
	reauthRecovery: { method: "POST", path: "/reauth/recovery" },
	reauthPasskey: { method: "POST", path: "/reauth/passkey" },

	account: { method: "GET", path: "/account" },
	changePassword: { method: "POST", path: "/account/password" },
	regenerateRecoveryKey: { method: "POST", path: "/account/recovery-key" },
	regenerateBackupCodes: { method: "POST", path: "/account/backup-codes" },
	managePlan: { method: "POST", path: "/account/plan-link" },
	deleteAccount: { method: "DELETE", path: "/account" },

	passkeyAvailability: { method: "GET", path: "/passkeys/availability" },
	passkeys: { method: "GET", path: "/passkeys" },
	passkeyRegister: { method: "POST", path: "/passkeys" },
	passkeyRemove: { method: "DELETE", path: "/passkeys/:passkeyId" },

	devices: { method: "GET", path: "/devices" },
	renameDevice: { method: "PATCH", path: "/devices/:deviceId" },
	revokeDevice: { method: "POST", path: "/devices/:deviceId/revoke" },
	confirmPending: { method: "POST", path: "/pending/:id/confirm" },
	cancelPending: { method: "POST", path: "/pending/:id/cancel" },

	pairShow: { method: "POST", path: "/pairing/show" },
	pairReview: { method: "GET", path: "/pairing/:pairingId/review" },
	pairApprove: { method: "POST", path: "/pairing/:pairingId/approve" },
	pairApproverScan: { method: "POST", path: "/pairing/approver/scan" },
	pairCancel: { method: "POST", path: "/pairing/:pairingId/cancel" },
	pairJoinerShow: { method: "POST", path: "/pairing/joiner/show" },
	pairJoin: { method: "POST", path: "/pairing/joiner/join" },
	pairFinish: { method: "POST", path: "/pairing/:pairingId/finish" },

	migrationReport: { method: "GET", path: "/migration/report" },
	migrationSyncthingSetAside: { method: "POST", path: "/migration/syncthing/set-aside" },
	migrationMerge: { method: "POST", path: "/migration/merge" },

	syncStatus: { method: "GET", path: "/sync/status" },
	syncNow: { method: "POST", path: "/sync/now" },

	historyDocuments: { method: "GET", path: "/history/documents" },
	historyVersions: { method: "GET", path: "/history/versions" },
	historyRestoreVersion: { method: "POST", path: "/history/restore-version" },
	historyPreview: { method: "GET", path: "/history/preview" },
	historyRestoreTo: { method: "POST", path: "/history/restore" },

	exportDownload: { method: "POST", path: "/export" },
	exportReminderGet: { method: "GET", path: "/export/reminder" },
	exportReminderSet: { method: "PUT", path: "/export/reminder" },
};

/** Error body of every failing route: a stable code the UI maps to text (strings.errors). */
export interface RouteErrorBody {
	error: string;
	message: string;
}
