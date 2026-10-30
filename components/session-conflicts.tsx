"use client";

import { useState } from "react";
import type { ChatConflict } from "@/src/core";

/**
 * Two devices changed this session before syncing (multi-device, GLOSSARY
 * "Conflict copy"): the learner picks the version to keep. The other moves
 * to this device's conflicts folder; nothing merges or vanishes silently.
 */
export function SessionConflicts({ chatId, current, conflicts }: { chatId: string; current: { updatedAt: string; messageCount: number }; conflicts: ChatConflict[] }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const when = (iso: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown time");
	const keep = async (choice: string) => {
		setBusy(true);
		try {
			const res = await fetch(`/api/chats/${chatId}/conflicts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ keep: choice }),
			});
			if (!res.ok) throw new Error(String(res.status));
			window.location.reload(); // the kept version may be a different transcript
		} catch {
			setError("Couldn’t keep that version. Try again.");
			setBusy(false);
		}
	};
	const button = "rounded-sm border border-border px-3 py-1 text-xs hover:bg-accent cursor-pointer disabled:opacity-50";
	return (
		<div data-testid="session-conflicts" className="pointer-events-auto mb-2 rounded-sm border border-border bg-card px-4 py-3 font-ui text-sm">
			<p className="text-foreground">This session was changed on two devices. Pick the version to keep; the other is set aside on this device.</p>
			{error && <p className="mt-1 text-xs text-red-500">{error}</p>}
			<div className="mt-2 flex flex-wrap gap-2">
				<button type="button" disabled={busy} className={button} onClick={() => void keep("current")}>
					Keep this one ({current.messageCount} messages, {when(current.updatedAt)})
				</button>
				{conflicts.map((c) => (
					<button key={c.file} type="button" disabled={busy} className={button} onClick={() => void keep(c.file)}>
						Keep the other ({c.messageCount} messages, {when(c.updatedAt)})
					</button>
				))}
			</div>
		</div>
	);
}
