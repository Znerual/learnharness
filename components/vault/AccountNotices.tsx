"use client";

import { useReducer } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { AccountResponse } from "@/src/core";
import { backupCodesWarning, managePlanVisible, reduceManagePlan } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Notice } from "./ui.tsx";

/** Warning at 3 or fewer backup codes (#12 style). `onReplace` opens the regenerate flow. */
export function BackupCodesWarning({ account, onReplace }: { account: Pick<AccountResponse, "backupCodesLeft">; onReplace: () => void }) {
	const w = backupCodesWarning(account);
	if (!w.show) return null;
	return (
		<Notice tone={w.severity} title={w.text} testid="backup-codes-warning">
			<p>{w.advice}</p>
			<div className="mt-2">
				<Button variant="secondary" onClick={onReplace}>
					{strings.account.backupCodesReplace}
				</Button>
			</div>
		</Notice>
	);
}

/** "Manage plan": hidden while billing is disabled (the beta). `openUrl` opens the system browser. */
export function ManagePlanView({ account, status, error, onOpen }: { account: Pick<AccountResponse, "billingEnabled">; status: "idle" | "working" | "failed"; error?: string | undefined; onOpen: () => void }) {
	if (!managePlanVisible(account)) return null;
	return (
		<section data-testid="manage-plan" className="flex flex-col gap-2">
			<h2 className="text-lg font-semibold">{strings.account.manageTitle}</h2>
			<p className="text-xs text-muted-foreground">{strings.account.manageHelp}</p>
			<div>
				<Button disabled={status === "working"} onClick={onOpen}>
					{status === "working" ? strings.account.manageWorking : strings.account.managePlan}
				</Button>
			</div>
			{status === "failed" ? <ErrorLine code={error ?? "generic"} /> : null}
		</section>
	);
}

export function ManagePlan({ api, account, openUrl }: { api: VaultApi; account: Pick<AccountResponse, "billingEnabled">; openUrl: (url: string) => void }) {
	const [s, dispatch] = useReducer(reduceManagePlan, { status: "idle" });
	return (
		<ManagePlanView
			account={account}
			status={s.status}
			error={s.error}
			onOpen={() => {
				dispatch({ type: "open" });
				api.managePlan()
					.then((r) => {
						openUrl(r.url); // the link is valid for 5 minutes and opens in the system browser
						dispatch({ type: "opened" });
					})
					.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
			}}
		/>
	);
}
