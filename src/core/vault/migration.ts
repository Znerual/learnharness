// Types of the migration routes (docs/vault-migration.md): what the data folder holds, what the
// upgrade would change, the Syncthing steps and the result of a merge. Types only, so the renderer can import them.

export type StepId = "backup" | "local-split" | "prompt-switches" | "stray-files" | "conflicts" | "graph-format" | "job-owner";

export interface PlannedStep {
	id: StepId;
	/** Plain-English title for the report. */
	title: string;
	/** How many files this step would touch. */
	files: number;
	/** Up to a few example paths, relative to the data folder. */
	examples: string[];
}

export interface ConflictItem {
	/** Relative to the data folder. */
	path: string;
	kind: "session" | "base-ledger" | "other";
	/**
	 * keep: a session conflict copy stays where LearnHarness's conflict picker reads it.
	 * promote: its session file is missing, so the copy becomes the session.
	 * merge-lines: lines the shared ledger lacks are added to it; the copy then goes to the conflicts folder.
	 * set-aside: moves to the device-local conflicts folder.
	 */
	action: "keep" | "promote" | "merge-lines" | "set-aside";
}

export interface MigrationReport {
	/**
	 * empty: nothing to migrate. older: written before the multi-device split (upstream builds, early fork builds).
	 * current: already in the format the vault syncs.
	 */
	layout: "empty" | "older" | "current";
	/** The graph format stamp of the folder, null when it has none (an older build). */
	graphFormat: number | null;
	counts: { sessions: number; jobs: number; ledgerFiles: number; prompts: number; conflicts: number };
	steps: PlannedStep[];
	conflicts: ConflictItem[];
	/** Unreadable session or job files; they move aside. */
	unreadable: string[];
	/** Set when the data was written by a newer build: nothing may change until the app is updated. */
	blocked: { reason: "data_newer"; paths: string[] } | null;
	/** Syncthing markers in or above the data folder. */
	syncthing: string[];
	/** True when a step is pending (a backup then happens before the first change). */
	needed: boolean;
}

export interface SyncthingSwitchPlan {
	needed: boolean;
	/** The markers found, with whether the app may set them aside (only those inside the data folder itself). */
	markers: { name: string; folder: string; canSetAside: boolean }[];
	/** The steps for the learner, in order. */
	steps: string[];
}

export interface MergeReport {
	from: string;
	at: string;
	sessions: { added: number; continued: number; identical: number; keptVault: number; conflictCopies: number };
	jobs: { added: number; identical: number; keptVault: number; skipped: number };
	prompts: { added: number; identical: number; keptVault: number; switchesMerged: boolean };
	sources: { added: number };
	graphLines: { added: number; linked: number };
	/** Files that stay in the moved-aside folder (other devices' ledgers come from the vault). */
	leftBehind: string[];
}

export interface MovedAsideDto {
	/** Folder name inside the device-local folder, `pre-vault-<date>`. */
	name: string;
	sessions: number;
	files: number;
	/** A merge of this folder has run. */
	merged: boolean;
}

export interface MigrationStateDto {
	report: MigrationReport;
	syncthing: SyncthingSwitchPlan;
	/** The last upgrade of this device: when, and where its backup is. */
	lastUpgrade: { at: string; backupDir: string } | null;
	movedAside: MovedAsideDto[];
}

/** The learner's answer on the join screen: replace local data (it moves aside) or merge it in. */
export type JoinChoice = "use-vault" | "merge";
