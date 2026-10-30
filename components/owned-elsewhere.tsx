"use client";

import { useState } from "react";

/** Another device's work in this session (GET /api/chats/[id] ownedElsewhere). */
export interface OwnedElsewhere {
	deviceId: string;
	deviceName: string;
	since: string;
	kind: "turn" | "job";
}

/**
 * Stands in for the composer while another device runs this session
 * (multi-device, GLOSSARY "Owning device"): the session is read-only here
 * until that work settles and syncs. TAKEOVER is always offered behind a
 * confirmation — the learner knows when the other device is gone.
 */
export function OwnedElsewhereBanner({ chatId, owner, onTakenOver }: { chatId: string; owner: OwnedElsewhere; onTakenOver: () => void }) {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const since = new Date(owner.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const what = owner.kind === "turn" ? "This session is running" : "A background job of this session is running";
	const takeOver = async () => {
		setBusy(true);
		try {
			const res = await fetch(`/api/chats/${chatId}/takeover`, { method: "POST" });
			if (!res.ok) throw new Error(String(res.status));
			onTakenOver();
		} catch {
			setError("Couldn’t take over. Try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div data-testid="owned-elsewhere" className="pointer-events-auto rounded-sm border border-border bg-card px-4 py-3 font-ui text-sm">
			<p className="text-foreground">
				{what} on {owner.deviceName} since {since}. It is read-only here until that finishes and syncs.
			</p>
			{error && <p className="mt-1 text-xs text-red-500">{error}</p>}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				{confirming ? (
					<>
						<span className="text-xs text-muted-foreground">
							Take over from {owner.deviceName}? Work still running there in this session stops.
						</span>
						<button type="button" data-testid="takeover-confirm" disabled={busy} onClick={() => void takeOver()} className="rounded-sm border border-border px-3 py-1 text-xs hover:bg-accent cursor-pointer">
							Take over
						</button>
						<button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded-sm px-3 py-1 text-xs text-muted-foreground hover:bg-accent cursor-pointer">
							Cancel
						</button>
					</>
				) : (
					<button type="button" data-testid="takeover" onClick={() => setConfirming(true)} className="rounded-sm border border-border px-3 py-1 text-xs hover:bg-accent cursor-pointer">
						Take over…
					</button>
				)}
			</div>
		</div>
	);
}
