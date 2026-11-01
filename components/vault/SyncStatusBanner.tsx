"use client";

import { useEffect, useState } from "react";
import type { VaultApi } from "@/src/core";
import type { SyncStatus } from "@/src/core";
import { strings } from "@/src/core";
import { syncBanner, type BannerAction } from "@/src/core";
import { Button, Notice } from "./ui.tsx";

/** Pure view of one SyncStatus. Quiet states render one line; problems render a banner. */
export function SyncStatusBannerView({ status, now, billingEnabled, onAction }: { status: SyncStatus; now: Date; billingEnabled: boolean; onAction?: (a: Exclude<BannerAction, null>) => void }) {
	const b = syncBanner(status, { now, billingEnabled });
	if (b.level === "line") {
		return (
			<p data-testid="sync-status" data-state={status.state} data-tone={b.tone} className="text-xs text-muted-foreground" aria-live="polite">
				{b.title}
				{status.pendingChanges > 0 ? ` · ${b.facts[0]}` : ""}
				{status.rejected > 0 ? ` · ${strings.sync.rejected(status.rejected)}` : ""}
			</p>
		);
	}
	return (
		<Notice tone={b.tone} title={b.title} testid="sync-status">
			<div data-state={status.state} className="flex flex-col gap-1">
				<p>{b.body}</p>
				<ul className="text-xs text-muted-foreground">
					{b.facts.map((f) => (
						<li key={f}>{f}</li>
					))}
				</ul>
				{b.action && b.actionLabel ? (
					<div>
						<Button variant="secondary" onClick={() => onAction?.(b.action as Exclude<BannerAction, null>)}>
							{b.actionLabel}
						</Button>
					</div>
				) : null}
			</div>
		</Notice>
	);
}

/** Polls the sync status every 5 seconds (the fork can swap this for its existing events stream). */
export function SyncStatusBanner({ api, billingEnabled, onAction, pollMs = 5000 }: { api: VaultApi; billingEnabled: boolean; onAction?: (a: Exclude<BannerAction, null>) => void; pollMs?: number }) {
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		let live = true;
		const tick = () =>
			api
				.syncStatus()
				.then((s) => {
					if (live) {
						setStatus(s);
						setNow(new Date());
					}
				})
				.catch(() => undefined);
		void tick();
		const t = setInterval(tick, pollMs);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [api, pollMs]);
	if (!status) return null;
	return <SyncStatusBannerView status={status} now={now} billingEnabled={billingEnabled} {...(onAction ? { onAction } : {})} />;
}
