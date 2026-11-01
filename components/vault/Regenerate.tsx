"use client";

import { useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { AccountDto, ReauthEvent } from "@/src/core";
import { initialRegenerate, reauthPasskeys, reduceRegenerate, regenerateSecrets, type RegenerateEvent, type RegenerateKind, type RegenerateState } from "@/src/core";
import { formatDateTime, strings } from "@/src/core";
import { BackupCodesWarning } from "./AccountNotices.tsx";
import { EmergencyKit } from "./EmergencyKit.tsx";
import { ReauthForm } from "./ReauthForm.tsx";
import { Button, ErrorLine, Notice, SecretBlock } from "./ui.tsx";

const kindLabel = { recovery_key: strings.account.recoveryKeyReplace, backup_codes: strings.account.backupCodesReplace } as const;

/**
 * Pure view of "replace the recovery key / backup codes": start buttons, re-authentication, the new
 * secrets once with the confirm step, and the 24 hour waiting state. The secrets exist only in the
 * `show` step (`regenerateSecrets`).
 */
export function RegenerateView({ state, dispatch, onStart, backupCodesLeft, reauthSlot }: { state: RegenerateState; dispatch: Dispatch<RegenerateEvent>; onStart: (kind: RegenerateKind) => void; backupCodesLeft?: number; reauthSlot?: () => ReactNode }) {
	const secrets = regenerateSecrets(state);
	return (
		<section data-testid="regenerate" data-step={state.step} className="flex flex-col gap-3">
			{state.step === "idle" || state.step === "failed" || state.step === "done" ? (
				<>
					<h2 className="text-lg font-semibold">{strings.account.regenerateTitle}</h2>
					<p className="text-xs text-muted-foreground">{strings.account.regenerateHelp}</p>
					{backupCodesLeft !== undefined ? <BackupCodesWarning account={{ backupCodesLeft }} onReplace={() => onStart("backup_codes")} /> : null}
				</>
			) : null}
			{state.step === "idle" || state.step === "failed" || state.step === "done" ? (
				<>
					{state.step === "failed" ? <ErrorLine code={state.error} /> : null}
					{state.step === "done" ? (
						<Notice tone="ok" testid="regenerate-done">
							<p>{strings.account.regenerateFinished[state.kind]}</p>
							{state.pending ? <p>{strings.account.regenerateWaiting(formatDateTime(state.pending.runsAt))}</p> : null}
						</Notice>
					) : null}
					<div className="flex flex-wrap gap-2">
						{(["recovery_key", "backup_codes"] as const).map((kind) => (
							<Button key={kind} variant="secondary" onClick={() => onStart(kind)}>
								{kindLabel[kind]}
							</Button>
						))}
					</div>
				</>
			) : null}
			{state.step === "reauth" ? (
				<>
					<h3 className="text-sm font-semibold">{kindLabel[state.kind]}</h3>
					{state.reauth.step === "form" ? reauthSlot?.() : <p className="text-sm">{strings.common.working}</p>}
					<div>
						<Button variant="link" onClick={() => dispatch({ type: "cancel" })}>
							{strings.common.cancel}
						</Button>
					</div>
				</>
			) : null}
			{state.step === "working" ? <p className="text-sm">{strings.account.regenerateWorking}</p> : null}
			{state.step === "show" && secrets ? (
				<div className="flex flex-col gap-3">
					<h3 className="text-sm font-semibold">{state.kind === "recovery_key" ? strings.account.recoveryKeyNew : strings.account.backupCodesNew}</h3>
					<p role="alert" className="text-sm font-medium">
						{strings.account.regenerateShowWarning} {strings.account.backupCodesNewWarning}
					</p>
					{secrets.recoveryKey ? <SecretBlock testid="recovery-key" label={strings.signup.recoveryKeyLabel} help={strings.signup.recoveryKeyHelp} value={secrets.recoveryKey} /> : null}
					{secrets.backupCodes ? <SecretBlock testid="backup-codes" label={strings.signup.backupCodesLabel} help={strings.signup.backupCodesHelp} value={secrets.backupCodes} /> : null}
					{secrets.kit ? <EmergencyKit kit={secrets.kit} /> : null}
					{state.pending ? (
						<Notice tone="warning" testid="regenerate-pending">
							{strings.account.regenerateWaiting(formatDateTime(state.pending.runsAt))}
						</Notice>
					) : null}
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" checked={state.acknowledged} onChange={(e) => dispatch({ type: "acknowledged", value: e.target.checked })} />
						{strings.account.regenerateAck}
					</label>
					<Button disabled={!state.acknowledged} onClick={() => dispatch({ type: "finish" })}>
						{strings.account.regenerateDone}
					</Button>
				</div>
			) : null}
		</section>
	);
}

/** Regenerate wired to the routes. `account` supplies the passkey count and the backup-codes warning. */
export function Regenerate({ api, account }: { api: VaultApi; account: AccountDto }) {
	const passkeys = reauthPasskeys(account);
	const [state, dispatch] = useReducer(reduceRegenerate, initialRegenerate);

	const reauthId = state.step === "reauth" && state.reauth.step === "granted" ? state.reauth.reauthId : null;
	const kind = state.step === "reauth" ? state.kind : null;
	useEffect(() => {
		if (!reauthId || !kind) return;
		dispatch({ type: "submitted" });
		if (kind === "recovery_key") {
			api.regenerateRecoveryKey({ reauthId })
				.then((r) => dispatch({ type: "result", rotation: r.rotation, recoveryKey: r.recoveryKey, kit: r.kit }))
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		} else {
			api.regenerateBackupCodes({ reauthId })
				.then((r) => dispatch({ type: "result", rotation: r.rotation, backupCodes: r.backupCodes }))
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		}
	}, [api, reauthId, kind]);

	return (
		<RegenerateView
			state={state}
			dispatch={dispatch}
			onStart={(k) => dispatch({ type: "start", kind: k, passkeys })}
			backupCodesLeft={account.backupCodesLeft}
			reauthSlot={() => (state.step === "reauth" && state.reauth.step === "form" ? <ReauthForm api={api} state={state.reauth} dispatch={(event: ReauthEvent) => dispatch({ type: "reauth", event })} /> : null)}
		/>
	);
}
