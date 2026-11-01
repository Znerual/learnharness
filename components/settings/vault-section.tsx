"use client";
/**
 * Settings → Vault: sign in to the vault, add a device, see sync and history, export, leave. Every
 * screen is a component of components/vault/ driven by a view model of src/core/vault/; this file
 * only picks the screen. The section only exists while the vault is available (components/vault/
 * available.ts), so a build without the vault shows no trace of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createVaultApi, reauthPasskeys, type AccountDto } from "@/src/core";
import { Button } from "@/components/ui/button";
import { ChangePasswordEntry } from "@/components/vault/ChangePassword";
import { Devices } from "@/components/vault/Devices";
import { DeleteAccount } from "@/components/vault/DeleteAccount";
import { ExportSettings } from "@/components/vault/ExportReminder";
import { History } from "@/components/vault/History";
import { ManagePlan } from "@/components/vault/AccountNotices";
import { Passkeys } from "@/components/vault/Passkeys";
import { PairingApprover, PairingJoiner } from "@/components/vault/Pairing";
import { Regenerate } from "@/components/vault/Regenerate";
import { Recover } from "@/components/vault/Recover";
import { SignIn } from "@/components/vault/SignIn";
import { SignUp } from "@/components/vault/SignUp";
import { SyncStatusBanner } from "@/components/vault/SyncStatusBanner";
import { Unlock } from "@/components/vault/Unlock";
import { SettingsGroup } from "./controls.tsx";

type Screen = "unlock" | "signin" | "signup" | "recover" | "join" | "new_password" | "account";

const api = createVaultApi({ base: "/api/vault" });

export function VaultSection() {
	const [screen, setScreen] = useState<Screen>("unlock");
	const [email, setEmail] = useState("");
	const [adding, setAdding] = useState(false);
	const [account, setAccount] = useState<AccountDto | null>(null);
	const [accountVersion, setAccountVersion] = useState(0);
	const reloadAccount = useCallback(() => setAccountVersion((v) => v + 1), []);

	const toAccount = useCallback(() => setScreen("account"), []);
	const onNeeds = useCallback((s: "sign_in" | "unlock" | "set_password") => setScreen(s === "set_password" ? "new_password" : "signin"), []);
	const signedOut = useCallback(() => {
		setAccount(null);
		setScreen("signin");
	}, []);

	useEffect(() => {
		if (screen !== "account") return;
		let live = true;
		api.account()
			.then((a) => live && setAccount(a))
			.catch(() => live && setAccount(null));
		return () => {
			live = false;
		};
	}, [screen, accountVersion]);

	const tabs = useMemo(
		() => [
			["signin", "Sign in"],
			["signup", "Create account"],
			["recover", "Recover"],
			["join", "Add this device"],
		] as const,
		[],
	);

	if (screen === "unlock") return <Unlock api={api} onReady={toAccount} onNeeds={onNeeds} />;

	if (screen === "account") {
		return (
			<div className="flex flex-col gap-3" data-testid="vault-account">
				<SyncStatusBanner api={api} billingEnabled={account?.billingEnabled ?? false} />
				{account ? (
					<>
						<SettingsGroup label="Plan">
							<ManagePlan api={api} account={account} openUrl={(url) => window.open(url, "_blank", "noopener")} />
						</SettingsGroup>
						<SettingsGroup label="Sign-in">
							<ChangePasswordEntry api={api} account={account} />
							<Passkeys api={api} onChanged={reloadAccount} />
						</SettingsGroup>
						<SettingsGroup label="Recovery">
							<Regenerate api={api} account={account} />
						</SettingsGroup>
						<SettingsGroup label="Devices">
							{adding ? (
								<>
									<PairingApprover api={api} />
									<Button variant="outline" size="sm" onClick={() => setAdding(false)}>
										Done
									</Button>
								</>
							) : (
								<Devices api={api} onAddDevice={() => setAdding(true)} onSignedOut={signedOut} />
							)}
						</SettingsGroup>
						<SettingsGroup label="History">
							<History api={api} retentionDays={account.historyRetentionDays} />
						</SettingsGroup>
						<SettingsGroup label="Export">
							<ExportSettings api={api} account={account} />
						</SettingsGroup>
						<SettingsGroup label="Delete account">
							<DeleteAccount api={api} email={account.email} passkeys={reauthPasskeys(account)} onDeleted={signedOut} />
						</SettingsGroup>
					</>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4" data-testid="vault-signed-out">
			<div className="flex flex-wrap gap-2">
				{tabs.map(([id, label]) => (
					<Button key={id} variant={screen === id ? "default" : "outline"} size="sm" onClick={() => setScreen(id)}>
						{label}
					</Button>
				))}
			</div>
			{screen === "signin" && (
				<SignIn
					api={api}
					initialEmail={email}
					onSignedIn={toAccount}
					onHandoff={(to, mail) => {
						setEmail(mail);
						setScreen(to === "recover" ? "recover" : "join");
					}}
				/>
			)}
			{screen === "signup" && <SignUp api={api} initialEmail={email} onDone={toAccount} />}
			{screen === "recover" && <Recover api={api} initialEmail={email} onDone={toAccount} />}
			{screen === "new_password" && <Recover api={api} startAtNewPassword onDone={toAccount} />}
			{screen === "join" && <PairingJoiner api={api} onJoined={toAccount} />}
		</div>
	);
}
