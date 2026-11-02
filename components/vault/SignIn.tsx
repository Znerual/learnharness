"use client";

import { useEffect, useReducer, type Dispatch } from "react";
import { errorCode, type PasskeyAvailabilityDto, type VaultApi } from "@/src/core";
import { initialSignIn, reduceSignIn, unlockChoices, type SignInEvent, type SignInState, type UnlockChoice } from "@/src/core";
import { strings } from "@/src/core";
import { usePasskeyAvailability } from "./hooks.ts";
import { Button, ErrorLine, Field, TextInput } from "./ui.tsx";

const choiceLabel: Record<UnlockChoice, string> = {
	password: strings.signin.unlockWithPassword,
	pairing: strings.signin.unlockWithPairing,
	recovery: strings.signin.unlockWithRecovery,
};

export interface SignInActions {
	submitPassword(): void;
	passkey(): void;
	unlock(): void;
}

/** `passkey`: whether the ceremony can run here; null while unknown, undefined for "always" (tests). */
export function SignInView({ state, dispatch, actions, passkey = { available: true } }: { state: SignInState; dispatch: Dispatch<SignInEvent>; actions: SignInActions; passkey?: PasskeyAvailabilityDto | null }) {
	const passkeyOff = passkey === null || !passkey.available;
	return (
		<div data-testid="signin" data-step={state.step} className="flex flex-col gap-4">
			{state.step === "form" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						actions.submitPassword();
					}}
				>
					<h2 className="text-lg font-semibold">{strings.signin.title}</h2>
					<Field label={strings.signin.emailLabel}>
						<TextInput type="email" autoComplete="username webauthn" value={state.email} onChange={(e) => dispatch({ type: "email_changed", email: e.target.value })} />
					</Field>
					<Field label={strings.signin.passwordLabel}>
						<TextInput type="password" autoComplete="current-password" value={state.password} onChange={(e) => dispatch({ type: "password_changed", password: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<Button type="submit" disabled={state.busy || !state.email || !state.password}>
						{state.busy && !state.passkeyWaiting ? strings.common.working : strings.signin.signIn}
					</Button>
					<Button variant="secondary" disabled={state.busy || !state.email || passkeyOff} onClick={actions.passkey}>
						{state.passkeyWaiting ? strings.signin.passkeyWorking : strings.signin.withPasskey}
					</Button>
					{passkey === null ? (
						<p data-testid="passkey-unavailable" className="text-xs text-muted-foreground">
							{strings.signin.passkeyChecking}
						</p>
					) : !passkey.available ? (
						<p data-testid="passkey-unavailable" className="text-xs text-muted-foreground">
							{strings.signin.passkeyUnavailable[passkey.reason]}
						</p>
					) : null}
					<Button variant="link" onClick={() => dispatch({ type: "forgot_password" })}>
						{strings.signin.orRecover}
					</Button>
				</form>
			) : null}
			{state.step === "needs_unlock" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						actions.unlock();
					}}
				>
					<h2 className="text-lg font-semibold">{strings.signin.signedInNeedsUnlockTitle}</h2>
					<p className="text-sm">{strings.signin.signedInNeedsUnlockHelp}</p>
					<Field label={strings.signin.passwordLabel} help={choiceLabel.password}>
						<TextInput type="password" autoComplete="current-password" value={state.password} onChange={(e) => dispatch({ type: "password_changed", password: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<Button type="submit" disabled={state.busy || !state.password}>
						{state.busy ? strings.common.working : strings.signin.unlockButton}
					</Button>
					{unlockChoices
						.filter((c) => c !== "password")
						.map((c) => (
							<Button key={c} variant="secondary" onClick={() => dispatch({ type: "choose", choice: c })}>
								{choiceLabel[c]}
							</Button>
						))}
				</form>
			) : null}
		</div>
	);
}

/**
 * Sign-in wired to the routes. `onSignedIn` fires when the vault is unlocked; `onHandoff` when the
 * learner chose recovery or pairing, which are separate screens (Recover, Pairing).
 */
export function SignIn({ api, onSignedIn, onHandoff, initialEmail }: { api: VaultApi; onSignedIn: () => void; onHandoff: (to: "recover" | "pairing", email: string) => void; initialEmail?: string }) {
	const [state, dispatch] = useReducer(reduceSignIn, initialEmail, initialSignIn);
	useEffect(() => {
		if (state.step === "signed_in") onSignedIn();
		if (state.step === "handoff") onHandoff(state.to, state.email);
	}, [state, onSignedIn, onHandoff]);

	const actions: SignInActions = {
		submitPassword() {
			if (state.step !== "form") return;
			dispatch({ type: "submit_password" });
			api.signIn({ email: state.email.trim(), password: state.password })
				.then((session) => dispatch({ type: "session", session }))
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		},
		passkey() {
			if (state.step !== "form") return;
			const email = state.email.trim();
			dispatch({ type: "passkey_started" });
			// the ceremony runs in the server process and the desktop passkey window; with PRF the
			// server unlocks, without it the session needs another unlock method
			api.passkeySignIn({ email })
				.then((session) => dispatch({ type: "session", session }))
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		},
		unlock() {
			if (state.step !== "needs_unlock") return;
			dispatch({ type: "submit_unlock" });
			api.unlockWithPassword({ password: state.password })
				.then((session) => dispatch({ type: "session", session }))
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		},
	};
	const passkey = usePasskeyAvailability(api);
	return <SignInView state={state} dispatch={dispatch} actions={actions} passkey={passkey} />;
}
