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
	| { state: "signed_in"; accountId: string; deviceId: string; ephemeral: boolean; offline: boolean };

export interface OneTimeSecrets {
	recoveryKey: string;
	backupCodes: string[];
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
	leaveVault: { req: { dryRun?: boolean }; res: { unpushed: number } };

	// sign-up
	passwordCheck: { req: { password: string }; res: PasswordCheckResult };
	signupStart: { req: { email: string }; res: Empty };
	signupVerify: { req: { email: string; code: string }; res: Empty };
	signupFinish: { req: { password: string }; res: { display: OneTimeSecrets; kit: EmergencyKit } };
	signupConfirm: { req: { typed: string }; res: { ok: boolean } };

	// sign-in, unlock, recovery
	signIn: { req: { email: string; password: string }; res: SessionDto };
	passkeySignInStart: { req: { email: string }; res: { ceremonyId: string; options: unknown } };
	passkeySignInFinish: { req: { email: string; ceremonyId: string; credential: unknown; prfOutput: string | null }; res: SessionDto };
	unlockWithPassword: { req: { password: string }; res: SessionDto };
	recover: { req: { email: string; secret: string }; res: SessionDto };
	setNewPassword: { req: { password: string }; res: RotationDto };

	// re-authentication (ADR 0013); grants stay on the server, the UI holds a short handle
	reauthPassword: { req: { password: string }; res: { reauthId: string; strength: ReauthStrength } };
	reauthRecovery: { req: { secret: string }; res: { reauthId: string; strength: ReauthStrength } };
	reauthPasskeyStart: { req: Empty; res: { ceremonyId: string; options: unknown } };
	reauthPasskeyFinish: { req: { ceremonyId: string; credential: unknown }; res: { reauthId: string; strength: ReauthStrength } };

	// account
	account: { req: Empty; res: AccountResponse };
	changePassword: { req: { password: string; reauthId: string }; res: RotationDto };
	regenerateRecoveryKey: { req: { reauthId: string }; res: { rotation: RotationDto; recoveryKey: string; kit: EmergencyKit } };
	regenerateBackupCodes: { req: { reauthId: string }; res: { rotation: RotationDto; backupCodes: string[] } };
	managePlan: { req: Empty; res: { url: string } };
	deleteAccount: { req: { email: string; reauthId: string }; res: Empty };

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
	pairCancel: { req: { pairingId: string }; res: Empty };
	pairJoinerShow: { req: Empty; res: { pairingId: string; qr: string; text: string; code: string } };
	pairJoin: { req: { code: string }; res: { pairingId: string; code: string } };
	pairFinish: { req: { pairingId: string }; res: SessionDto };

	// sync
	syncStatus: { req: Empty; res: SyncStatus };
	syncNow: { req: Empty; res: SyncStatus };

	// history
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
	leaveVault: { method: "POST", path: "/session/leave" },

	passwordCheck: { method: "POST", path: "/password/check" },
	signupStart: { method: "POST", path: "/signup/start" },
	signupVerify: { method: "POST", path: "/signup/verify" },
	signupFinish: { method: "POST", path: "/signup/finish" },
	signupConfirm: { method: "POST", path: "/signup/confirm" },

	signIn: { method: "POST", path: "/sign-in/password" },
	passkeySignInStart: { method: "POST", path: "/sign-in/passkey/start" },
	passkeySignInFinish: { method: "POST", path: "/sign-in/passkey/finish" },
	unlockWithPassword: { method: "POST", path: "/unlock/password" },
	recover: { method: "POST", path: "/recover" },
	setNewPassword: { method: "POST", path: "/recover/new-password" },

	reauthPassword: { method: "POST", path: "/reauth/password" },
	reauthRecovery: { method: "POST", path: "/reauth/recovery" },
	reauthPasskeyStart: { method: "POST", path: "/reauth/passkey/start" },
	reauthPasskeyFinish: { method: "POST", path: "/reauth/passkey/finish" },

	account: { method: "GET", path: "/account" },
	changePassword: { method: "POST", path: "/account/password" },
	regenerateRecoveryKey: { method: "POST", path: "/account/recovery-key" },
	regenerateBackupCodes: { method: "POST", path: "/account/backup-codes" },
	managePlan: { method: "POST", path: "/account/plan-link" },
	deleteAccount: { method: "DELETE", path: "/account" },

	devices: { method: "GET", path: "/devices" },
	renameDevice: { method: "PATCH", path: "/devices/:deviceId" },
	revokeDevice: { method: "POST", path: "/devices/:deviceId/revoke" },
	confirmPending: { method: "POST", path: "/pending/:id/confirm" },
	cancelPending: { method: "POST", path: "/pending/:id/cancel" },

	pairShow: { method: "POST", path: "/pairing/show" },
	pairReview: { method: "GET", path: "/pairing/:pairingId/review" },
	pairApprove: { method: "POST", path: "/pairing/:pairingId/approve" },
	pairCancel: { method: "POST", path: "/pairing/:pairingId/cancel" },
	pairJoinerShow: { method: "POST", path: "/pairing/joiner/show" },
	pairJoin: { method: "POST", path: "/pairing/joiner/join" },
	pairFinish: { method: "POST", path: "/pairing/:pairingId/finish" },

	syncStatus: { method: "GET", path: "/sync/status" },
	syncNow: { method: "POST", path: "/sync/now" },

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
