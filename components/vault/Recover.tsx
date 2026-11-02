"use client";

import { useCallback, useReducer, type Dispatch } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { PasswordCheckResult } from "@/src/core";
import { initialRecover, reduceRecover, recoverPasswordView, type RecoverEvent, type RecoverState } from "@/src/core";
import { strings } from "@/src/core";
import { useBreachCheck } from "./hooks.ts";
import { Button, ErrorLine, Field, RuleList, TextInput } from "./ui.tsx";

export function RecoverView({ state, dispatch, onSubmitSecret, onSubmitPassword, onDone }: { state: RecoverState; dispatch: Dispatch<RecoverEvent>; onSubmitSecret: () => void; onSubmitPassword: () => void; onDone?: () => void }) {
	return (
		<div data-testid="recover" data-step={state.step} className="flex flex-col gap-4">
			{state.step === "form" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmitSecret();
					}}
				>
					<h2 className="text-lg font-semibold">{strings.recover.title}</h2>
					<p className="text-sm">{strings.recover.help}</p>
					<Field label={strings.recover.emailLabel}>
						<TextInput type="email" autoComplete="email" value={state.email} onChange={(e) => dispatch({ type: "email_changed", email: e.target.value })} />
					</Field>
					<Field label={strings.recover.secretLabel} help={strings.recover.secretHelp}>
						<TextInput autoComplete="off" spellCheck={false} className="font-mono" value={state.secret} onChange={(e) => dispatch({ type: "secret_changed", secret: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<Button type="submit" disabled={state.busy}>
						{state.busy ? strings.common.working : strings.recover.submit}
					</Button>
				</form>
			) : null}
			{state.step === "new_password" ? <NewPassword state={state} dispatch={dispatch} onSubmit={onSubmitPassword} /> : null}
			{state.step === "done" ? (
				<div className="flex flex-col gap-3">
					<p className="text-sm">{strings.recover.done}</p>
					<Button onClick={onDone}>{strings.signup.doneButton}</Button>
				</div>
			) : null}
		</div>
	);
}

function NewPassword({ state, dispatch, onSubmit }: { state: Extract<RecoverState, { step: "new_password" }>; dispatch: Dispatch<RecoverEvent>; onSubmit: () => void }) {
	const v = recoverPasswordView(state);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		>
			<h2 className="text-lg font-semibold">{strings.recover.newPasswordTitle}</h2>
			<p className="text-sm">{strings.recover.newPasswordHelp}</p>
			<Field label={strings.signup.passwordLabel}>
				<TextInput type="password" autoComplete="new-password" value={state.password} onChange={(e) => dispatch({ type: "password_changed", password: e.target.value })} />
			</Field>
			<RuleList feedback={v.feedback} />
			<Field label={strings.signup.passwordConfirmLabel} error={v.mismatch ? strings.signup.passwordMismatch : undefined}>
				<TextInput type="password" autoComplete="new-password" value={state.confirm} onChange={(e) => dispatch({ type: "confirm_changed", confirm: e.target.value })} />
			</Field>
			<ErrorLine code={state.error} />
			<Button type="submit" disabled={!v.canSubmit}>
				{state.busy ? strings.common.working : strings.recover.newPasswordSubmit}
			</Button>
		</form>
	);
}

/** Recovery wired to the routes. Pass `startAtNewPassword` for a device that must still set one. */
export function Recover({ api, onDone, initialEmail, startAtNewPassword }: { api: VaultApi; onDone?: () => void; initialEmail?: string; startAtNewPassword?: boolean }) {
	const [state, dispatch] = useReducer(reduceRecover, undefined, () => initialRecover(startAtNewPassword ? "new_password" : "form", initialEmail ?? ""));
	const onBreach = useCallback((password: string, result: PasswordCheckResult) => dispatch({ type: "breach_result", password, result }), []);
	useBreachCheck(api, state.step === "new_password" ? state.password : "", state.step === "new_password" ? state.breach : null, onBreach);
	return (
		<RecoverView
			state={state}
			dispatch={dispatch}
			{...(onDone ? { onDone } : {})}
			onSubmitSecret={() => {
				if (state.step !== "form") return;
				dispatch({ type: "submit_secret" });
				if (!state.email.trim() || state.secret.replace(/[\s-]/g, "").length < 8) return;
				api.recover({ email: state.email.trim(), secret: state.secret })
					.then((session) => dispatch({ type: "session", session }))
					.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
			}}
			onSubmitPassword={() => {
				if (state.step !== "new_password" || !recoverPasswordView(state).canSubmit) return;
				dispatch({ type: "submit_password" });
				api.setNewPassword({ password: state.password })
					.then((out) => dispatch({ type: "password_set", pending: out.status === "pending" }))
					.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
			}}
		/>
	);
}
