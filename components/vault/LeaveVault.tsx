"use client";

import { useState } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Notice } from "./ui.tsx";

/**
 * "Leave the vault on this device": stops syncing and deletes the sync data and keys here. The
 * outbox count (a dry run of leaveVault) is shown before the learner confirms, so changes that
 * never reached the vault are not lost by surprise.
 */
export function LeaveVaultView({ unpushed, busy, error, onAsk, onConfirm, onCancel }: { unpushed: number | null; busy: boolean; error?: string | undefined; onAsk: () => void; onConfirm: () => void; onCancel: () => void }) {
	return (
		<section data-testid="leave-vault" className="flex flex-col gap-2">
			<h2 className="text-lg font-semibold">{strings.account.leaveTitle}</h2>
			<p className="text-xs text-muted-foreground">{strings.account.leaveHelp}</p>
			<ErrorLine code={error} />
			{unpushed === null ? (
				<div>
					<Button variant="secondary" disabled={busy} onClick={onAsk}>
						{strings.account.leaveConfirm}
					</Button>
				</div>
			) : (
				<Notice tone="warning" title={strings.leave.title} testid="leave-confirm">
					<p data-testid="unpushed" data-count={unpushed}>
						{unpushed > 0 ? strings.leave.unpushed(unpushed) : strings.leave.none}
					</p>
					<div className="mt-2 flex gap-2">
						<Button variant="danger" disabled={busy} onClick={onConfirm}>
							{unpushed > 0 ? strings.leave.confirm : strings.account.leaveConfirm}
						</Button>
						<Button variant="secondary" disabled={busy} onClick={onCancel}>
							{strings.common.cancel}
						</Button>
					</div>
				</Notice>
			)}
		</section>
	);
}

export function LeaveVault({ api, onLeft }: { api: VaultApi; onLeft: () => void }) {
	const [unpushed, setUnpushed] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	return (
		<LeaveVaultView
			unpushed={unpushed}
			busy={busy}
			error={error}
			onAsk={() => {
				setBusy(true);
				setError(undefined);
				api.leaveVault({ dryRun: true })
					.then((r) => setUnpushed(r.unpushed))
					.catch((e) => setError(errorCode(e)))
					.finally(() => setBusy(false));
			}}
			onConfirm={() => {
				setBusy(true);
				api.leaveVault({ dryRun: false })
					.then(onLeft)
					.catch((e) => {
						setBusy(false);
						setError(errorCode(e));
					});
			}}
			onCancel={() => setUnpushed(null)}
		/>
	);
}
