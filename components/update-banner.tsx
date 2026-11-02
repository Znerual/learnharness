"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded). Snapshot retrieval
 * also covers a late load. The card offers Restart alongside Settings.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * Dismissing hides this version for the mounted window only; the update
 * still installs on quit (autoInstallOnAppQuit) or via Settings.
 */

import { useState } from "react";
import { XIcon } from "lucide-react";
import { useUpdateState } from "@/components/settings/update-settings.tsx";
import { ReleaseNotesList } from "@/components/release-notes-list";

export default function UpdateBanner() {
	const { state: ready } = useUpdateState();
	const [dismissedVersion, setDismissedVersion] = useState<string | null>();
	const [open, setOpen] = useState(false);
	if (ready?.status !== "downloaded" || ready.version === dismissedVersion) return null;
	const notes = ready.notes ?? [];
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex max-w-md flex-col gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			{open && notes.length > 0 && (
				<div className="max-h-72 overflow-y-auto border-b border-border pb-3" data-testid="update-banner-notes">
					<ReleaseNotesList notes={notes} />
				</div>
			)}
			<div className="flex items-center gap-3">
				<div className="text-sm">
					<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
					<span className="text-muted-foreground"> — restart to finish installing.</span>
				</div>
				{notes.length > 0 && (
					<button
						type="button"
						aria-expanded={open}
						data-testid="update-banner-whats-new"
						onClick={() => setOpen((o) => !o)}
						className="shrink-0 rounded-md px-2 py-1.5 text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
					>
						{open ? "Hide" : "What\u2019s new"}
					</button>
				)}
				<button
					type="button"
					onClick={() => window.lh?.installUpdate?.()}
					className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
				>
					Restart
				</button>
				<button
					type="button"
					aria-label="Dismiss update notification"
					onClick={() => setDismissedVersion(ready.version)}
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<XIcon className="size-4" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}
