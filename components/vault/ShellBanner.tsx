"use client";

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { createVaultApi, shellBanner, strings, type SessionDto, type ShellBanner, type SyncStatus, type VaultApi } from "@/src/core";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { useVaultAvailable } from "./available.ts";

const api = createVaultApi({ base: "/api/vault" });

/** Pure view: a small card at the bottom of the window. Renders nothing for a quiet state (banner null). */
export function ShellBannerView({ banner, onOpen, onDismiss }: { banner: ShellBanner | null; onOpen: () => void; onDismiss: () => void }) {
	if (!banner) return null;
	const color = { ok: "border-success", info: "border-border", warning: "border-warning", error: "border-error" }[banner.tone];
	return (
		<div
			role={banner.tone === "error" ? "alert" : "status"}
			data-testid="vault-shell-banner"
			data-key={banner.key}
			data-tone={banner.tone}
			className={`fixed bottom-4 left-1/2 z-40 flex max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-lg border border-l-4 bg-popover px-3 py-2 text-sm shadow-lg ${color}`}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				<p className="font-medium">{banner.title}</p>
				<p className="text-xs text-muted-foreground">{banner.body}</p>
				<button type="button" data-testid="vault-shell-banner-open" onClick={onOpen} className="w-fit text-xs underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					{strings.banner.open}
				</button>
			</div>
			<button type="button" aria-label={strings.banner.dismiss} onClick={onDismiss} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<XIcon className="size-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

interface Snapshot {
	session: SessionDto;
	status: SyncStatus | null;
}

/** Session and sync status every `pollMs`, paused while the window is hidden. Null until the first answer. */
function useVaultSnapshot(api: VaultApi, enabled: boolean, pollMs: number): Snapshot | null {
	const [snap, setSnap] = useState<Snapshot | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const tick = async () => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			try {
				const session = await api.session();
				const status = session.state === "signed_in" ? await api.syncStatus() : null;
				if (live) setSnap({ session, status });
			} catch {
				// the server is busy or restarting: keep the last answer
			}
		};
		void tick();
		const t = setInterval(() => void tick(), pollMs);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [api, enabled, pollMs]);
	return snap;
}

/**
 * The sync status in the app shell (not only in Settings): over quota, read-only, rotation
 * rejected, revoked, needs unlock, offline, sync errors. Hidden while idle, and entirely while the
 * vault is unavailable or the learner is signed out. It links to Settings → Vault; dismissing hides
 * that problem until a different one appears (or the app restarts).
 */
export function VaultShellBanner({ pollMs = 10_000 }: { pollMs?: number }) {
	const available = useVaultAvailable();
	const { open } = useSettingsDialog();
	const snap = useVaultSnapshot(api, available, pollMs);
	const [dismissed, setDismissed] = useState<string | null>(null);
	if (!available || !snap) return null;
	const banner = shellBanner(snap.session, snap.status, { now: new Date(), billingEnabled: false /* the plan action lives in Settings */ });
	if (!banner || banner.key === dismissed) return null;
	return <ShellBannerView banner={banner} onOpen={() => open("vault")} onDismiss={() => setDismissed(banner.key)} />;
}
