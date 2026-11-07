// Response shapes of the vault API (docs/protocol/api.md). Binary fields are base64url strings.

export interface DeviceInput {
	lhDeviceId: string;
	name: string;
	ephemeral: boolean;
	keysProtected?: boolean;
}

export interface MethodRow {
	id: string;
	kind: "password" | "passkey" | "recovery_key" | "backup_code" | "device";
	publicKey: string;
	sealed: string;
	commitment: string | null;
	pkTag: string;
	authPublicKey?: string;
	deviceId: string | null;
	passkeyId: string | null;
	createdAt: string;
}

export interface WrapRow {
	name: string;
	wrap: string;
}

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

export interface KeysResponse {
	accountId: string;
	generation: number;
	epoch: number;
	accountSalt: string;
	ksfVersion: number;
	wraps: WrapRow[];
	methods: MethodRow[];
	pendingAction: PendingAction | null;
	deviceId: string;
}

export interface SignInResponse {
	accountId: string;
	deviceId: string;
	deviceToken: string;
	newDevice?: boolean;
}

export interface ChangeRow {
	recordId: string;
	kind: "doc" | "seg";
	seq: number;
	epoch: number;
	size: number;
	sha256: string;
	tombstone: boolean;
	deviceId: string | null;
	deviceName: string;
	createdAt: string;
}

export interface ChangesResponse {
	changes: ChangeRow[];
	cursor: number;
	more: boolean;
	lastSeq: number;
	generation: number;
	epoch: number;
}

export interface WriteMeta {
	recordId: string;
	kind: "doc" | "seg";
	baseSeq?: number;
	epoch: number;
	tombstone: boolean;
	sha256: string;
	size: number;
}

export type WriteResult =
	| { recordId: string; status: "accepted"; seq: number }
	| { recordId: string; status: "conflict"; headSeq: number }
	| { recordId: string; status: "stale_epoch"; generation: number; epoch: number }
	| { recordId: string; status: "exists"; sha256: string }
	| { recordId: string; status: "payment_required"; error: "quota_exceeded" | "read_only" | "plan_required"; message: string }
	| { recordId: string; status: "rejected"; error: string; message: string };

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

export interface GrantResponse {
	grant: string;
	strength: "password" | "passkey" | "recovery";
	expiresAt: string;
	consumedMethodId?: string | null;
}
