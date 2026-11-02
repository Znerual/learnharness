"use client";

import { useState } from "react";
import { errorCode, type SessionDto, type VaultApi } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Notice } from "./ui.tsx";

/**
 * "Joining the vault of <email>": this device is signed in and nothing syncs yet. With local data
 * and a vault that already holds records it is the join question of ADR 0007: "Use the vault"
 * moves this device's files to pre-vault-<date>/ (never deleted), "Merge with the vault" does the same and then
 * folds them back in (docs/vault-migration.md), or cancel and sign out.
 * Without local data it is only a chance to cancel.
 */
export function JoinView({ email, localFiles, busy, error, onUse, onMerge, onCancel }: { email: string; localFiles: number; busy: boolean; error?: string | undefined; onUse: () => void; onMerge?: () => void; onCancel: () => void }) {
	const ask = localFiles > 0;
	return (
		<section data-testid="join" data-ask={ask ? "true" : "false"} className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold">{strings.join.title(email)}</h2>
			<p className="text-sm">{strings.join.help}</p>
			{ask ? (
				<Notice tone="warning" title={strings.join.confirmTitle} testid="join-confirm">
					<p>{strings.join.confirmBody(localFiles)}</p>
					{onMerge ? <p className="mt-1">{strings.join.mergeHelp}</p> : null}
				</Notice>
			) : null}
			<ErrorLine code={error} />
			<div className="flex flex-wrap gap-2">
				{ask && onMerge ? (
					<Button disabled={busy} onClick={onMerge}>
						{busy ? strings.join.working : strings.join.confirmMerge}
					</Button>
				) : null}
				<Button variant={ask && onMerge ? "secondary" : "primary"} disabled={busy} onClick={onUse}>
					{busy ? strings.join.working : ask ? strings.join.confirmUse : strings.join.start}
				</Button>
				<Button variant="secondary" disabled={busy} onClick={onCancel}>
					{ask ? strings.join.confirmCancel : strings.join.cancel}
				</Button>
			</div>
		</section>
	);
}

/** Join wired to the routes. `onDone` gets the session that follows: signed in (syncing) or signed out (cancelled). */
export function Join({ api, email, localFiles, onDone }: { api: VaultApi; email: string; localFiles: number; onDone: (session: SessionDto) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const answer = (choice: "use-vault" | "merge" | "cancel") => {
		setBusy(true);
		setError(undefined);
		api.joinConfirm({ choice })
			.then(onDone)
			.catch((e) => {
				setBusy(false);
				setError(errorCode(e));
			});
	};
	return <JoinView email={email} localFiles={localFiles} busy={busy} error={error} onUse={() => answer("use-vault")} onMerge={() => answer("merge")} onCancel={() => answer("cancel")} />;
}
