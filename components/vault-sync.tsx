"use client";
/**
 * The graph chrome's "Sync vault" button (obsidian wave, owner
 * 2026-10-24): imports every new or changed note of the configured
 * Obsidian vault (POST /api/graph/obsidian/sync). Hidden while no vault
 * is set (Settings → Graph). The per-file runs surface in the status
 * chips like any notes import; this button only shows the Sync's own
 * counters, polled every 3 s while a Sync runs.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useActivity } from "@/components/activity-dock";
import { useSettingsSaved } from "@/components/settings-signal";
import { Hint } from "@/components/ui/hint";

interface SyncStatus {
	running: boolean;
	total: number;
	skipped: number;
	done: number;
	failed: number;
	error?: string;
}

/** The button label for a status. Pure — exported for tests. */
export function vaultSyncLabel(status: SyncStatus | null): string {
	if (!status) return "Sync vault";
	if (status.running) return `Syncing ${status.done + status.failed}/${status.total}…`;
	return "Sync vault";
}

/** The hint line for a status. Pure — exported for tests. */
export function vaultSyncHint(status: SyncStatus | null, error: string | null): string {
	if (error) return error;
	if (status?.error) return status.error;
	if (status && status.total + status.skipped > 0) {
		const failed = status.failed ? `, ${status.failed} failed` : "";
		return `Last sync: ${status.done} imported${failed}, ${status.skipped} unchanged`;
	}
	return "Import new and changed notes from your Obsidian vault";
}

export function VaultSyncButton() {
	const [vault, setVault] = useState<string | null>(null);
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refreshActivity = useActivity().refresh;

	const read = useCallback(() => {
		fetch("/api/graph/obsidian/sync")
			.then((r) => r.json())
			.then((body: { status: SyncStatus; vault: string | null }) => {
				setVault(body.vault);
				setStatus(body.status);
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "graph") read();
	});
	useEffect(() => {
		if (!status?.running) return;
		const timer = setInterval(read, 3000);
		return () => clearInterval(timer);
	}, [status?.running, read]);

	if (!vault) return null;

	async function start() {
		setError(null);
		const res = await fetch("/api/graph/obsidian/sync", { method: "POST" }).catch(() => null);
		const body = (await res?.json().catch(() => ({}))) as { status?: SyncStatus; error?: string } | undefined;
		if (body?.status) setStatus(body.status);
		if (!res || (!res.ok && res.status !== 409)) setError(body?.error ?? "Sync failed to start");
		refreshActivity();
		setTimeout(() => refreshActivity(), 600);
	}

	return (
		<Hint label={vaultSyncHint(status, error)} side="bottom">
			<button
				type="button"
				disabled={status?.running}
				onClick={() => void start()}
				data-testid="sync-vault"
				className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
			>
				<RefreshCwIcon className={`size-3${status?.running ? " animate-spin" : ""}`} />
				{vaultSyncLabel(status)}
			</button>
		</Hint>
	);
}
