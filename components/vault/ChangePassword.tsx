"use client";

import { useCallback, useEffect, useReducer, useState, type Dispatch, type ReactNode } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { PasswordCheckResult, ReauthEvent } from "@/src/core";
import { changePasswordView, initialChangePassword, reauthPasskeys, reduceChangePassword, type ChangePasswordEvent, type ChangePasswordState } from "@/src/core";
import { strings } from "@/src/core";
import { ReauthForm } from "./ReauthForm.tsx";
import { useBreachCheck } from "./hooks.ts";
import { Button, ErrorLine, Field, Notice, RuleList, TextInput } from "./ui.tsx";

/** Pure view of the change-password flow: new password, then re-authentication, then the result. */
export function ChangePasswordView({ state, dispatch, onContinue, reauthSlot, onCancel }: { state: ChangePasswordState; dispatch: Dispatch<ChangePasswordEvent>; onContinue: () => void; reauthSlot?: () => ReactNode; onCancel?: () => void }) {
	return (
		<section data-testid="change-password" data-step={state.step} className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold">{strings.account.changePassword}</h2>
			{state.step === "form" ? <ChangePasswordForm state={state} dispatch={dispatch} onContinue={onContinue} onCancel={onCancel} /> : null}
			{state.step === "reauth" ? (
				<>
					<ErrorLine code={state.error} />
					{state.reauth.step === "form" ? reauthSlot?.() : <p className="text-sm">{strings.common.working}</p>}
				</>
			) : null}
			{state.step === "done" ? (
				<Notice tone="ok" testid="change-password-done">
					<p>{strings.account.changePasswordDone}</p>
					{state.pending ? <p data-testid="change-password-pending">{strings.account.changePasswordPending}</p> : null}
				</Notice>
			) : null}
		</section>
	);
}

function ChangePasswordForm({ state, dispatch, onContinue, onCancel }: { state: Extract<ChangePasswordState, { step: "form" }>; dispatch: Dispatch<ChangePasswordEvent>; onContinue: () => void; onCancel: (() => void) | undefined }) {
	const v = changePasswordView(state);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onContinue();
			}}
		>
			<p className="text-sm">{strings.account.changePasswordHelp}</p>
			<Field label={strings.account.changePasswordNew}>
				<TextInput type="password" autoComplete="new-password" value={state.password} onChange={(e) => dispatch({ type: "password_changed", password: e.target.value })} />
			</Field>
			<RuleList feedback={v.feedback} />
			<Field label={strings.account.changePasswordRepeat} error={v.mismatch ? strings.signup.passwordMismatch : undefined}>
				<TextInput type="password" autoComplete="new-password" value={state.confirm} onChange={(e) => dispatch({ type: "confirm_changed", confirm: e.target.value })} />
			</Field>
			<ErrorLine code={state.error} />
			<div className="flex gap-2">
				<Button type="submit" disabled={!v.canSubmit}>
					{strings.common.continue}
				</Button>
				{onCancel ? (
					<Button variant="secondary" onClick={onCancel}>
						{strings.common.cancel}
					</Button>
				) : null}
			</div>
		</form>
	);
}

/** Change password wired to the routes. `passkeys` is the count usable for re-authentication (`reauthPasskeys(account)`). */
export function ChangePassword({ api, passkeys = 0, onCancel }: { api: VaultApi; passkeys?: number; onCancel?: () => void }) {
	const [state, dispatch] = useReducer((s: ChangePasswordState, e: ChangePasswordEvent) => reduceChangePassword(s, e, passkeys), undefined, initialChangePassword);
	const onBreach = useCallback((password: string, result: PasswordCheckResult) => dispatch({ type: "breach_result", password, result }), []);
	useBreachCheck(api, state.step === "form" ? state.password : "", state.step === "form" ? state.breach : null, onBreach);

	// when the re-authentication holds a fresh grant, make the one call
	const reauthId = state.step === "reauth" && !state.submitted && state.reauth.step === "granted" ? state.reauth.reauthId : null;
	const password = state.step === "reauth" ? state.password : "";
	useEffect(() => {
		if (!reauthId) return;
		dispatch({ type: "submitted" });
		api.changePassword({ password, reauthId })
			.then((rotation) => dispatch({ type: "changed", rotation }))
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	}, [api, reauthId, password]);

	return (
		<ChangePasswordView
			state={state}
			dispatch={dispatch}
			{...(onCancel ? { onCancel } : {})}
			onContinue={() => dispatch({ type: "continue" })}
			reauthSlot={() => (state.step === "reauth" && state.reauth.step === "form" ? <ReauthForm api={api} state={state.reauth} dispatch={(event: ReauthEvent) => dispatch({ type: "reauth", event })} /> : null)}
		/>
	);
}

/** The account's "Change password" entry: a button that opens the flow. */
export function ChangePasswordEntry({ api, account }: { api: VaultApi; account: Parameters<typeof reauthPasskeys>[0] }) {
	const [open, setOpen] = useState(false);
	if (!open) {
		return (
			<Button variant="secondary" onClick={() => setOpen(true)}>
				{strings.account.changePassword}
			</Button>
		);
	}
	return <ChangePassword api={api} passkeys={reauthPasskeys(account)} onCancel={() => setOpen(false)} />;
}
