"use client";

import { useCallback, useReducer, type Dispatch } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { PasswordCheckResult } from "@/src/core";
import { initialSignup, reduceSignup, signupPasswordView, signupStepIndex, visibleSecrets, type SignupEvent, type SignupState } from "@/src/core";
import { strings } from "@/src/core";
import { EmergencyKit } from "./EmergencyKit.tsx";
import { useBreachCheck } from "./hooks.ts";
import { Button, ErrorLine, Field, RuleList, SecretBlock, Steps, TextInput } from "./ui.tsx";

export interface SignUpActions {
	sendCode(): void;
	resendCode(): void;
	verify(): void;
	createAccount(): void;
	confirm(): void;
}

/** Pure view: renders one step from the state. The secrets exist only in the `secrets` and `kit` steps. */
export function SignUpView({ state, dispatch, actions, onDone }: { state: SignupState; dispatch: Dispatch<SignupEvent>; actions: SignUpActions; onDone?: () => void }) {
	const secrets = visibleSecrets(state);
	return (
		<div data-testid="signup" data-step={state.step} className="flex flex-col gap-4">
			<h2 className="text-lg font-semibold">{strings.signup.title}</h2>
			{state.step !== "done" ? <Steps labels={strings.signup.steps} index={signupStepIndex(state)} /> : null}
			{state.step === "email" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						actions.sendCode();
					}}
				>
					<Field label={strings.signup.emailLabel} help={strings.signup.emailHelp}>
						<TextInput type="email" autoComplete="email" value={state.email} onChange={(e) => dispatch({ type: "email_changed", email: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<Button type="submit" disabled={state.busy}>
						{state.busy ? strings.common.working : strings.signup.sendCode}
					</Button>
				</form>
			) : null}
			{state.step === "code" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						actions.verify();
					}}
				>
					<h3 className="text-sm font-semibold">{strings.signup.codeTitle}</h3>
					<p className="text-sm">{strings.signup.codeHelp(state.email)}</p>
					<Field label={strings.signup.codeLabel}>
						<TextInput inputMode="text" autoComplete="one-time-code" maxLength={12} className="font-mono tracking-widest" value={state.code} onChange={(e) => dispatch({ type: "code_changed", code: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<div className="flex gap-2">
						<Button type="submit" disabled={state.busy}>
							{state.busy ? strings.common.working : strings.signup.verify}
						</Button>
						<Button variant="link" disabled={state.busy} onClick={actions.resendCode}>
							{strings.signup.resend}
						</Button>
					</div>
				</form>
			) : null}
			{state.step === "password" ? <PasswordStep state={state} dispatch={dispatch} onSubmit={actions.createAccount} /> : null}
			{state.step === "secrets" && secrets ? (
				<div className="flex flex-col gap-3">
					<h3 className="text-sm font-semibold">{strings.signup.secretsTitle}</h3>
					<p role="alert" className="text-sm font-medium">
						{strings.signup.secretsWarning}
					</p>
					<SecretBlock testid="recovery-key" label={strings.signup.recoveryKeyLabel} help={strings.signup.recoveryKeyHelp} value={secrets.recoveryKey} />
					<SecretBlock testid="backup-codes" label={strings.signup.backupCodesLabel} help={strings.signup.backupCodesHelp} value={secrets.backupCodes} />
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" checked={state.acknowledged} onChange={(e) => dispatch({ type: "acknowledged", value: e.target.checked })} />
						{strings.signup.secretsAck}
					</label>
					<Button disabled={!state.acknowledged} onClick={() => dispatch({ type: "next" })}>
						{strings.common.continue}
					</Button>
				</div>
			) : null}
			{state.step === "kit" && secrets ? (
				<div className="flex flex-col gap-3">
					<h3 className="text-sm font-semibold">{strings.signup.kitTitle}</h3>
					<p className="text-sm">{strings.signup.kitHelp}</p>
					<EmergencyKit kit={secrets.kit} onPrint={() => dispatch({ type: "kit_opened" })} />
					<Button variant="secondary" onClick={() => dispatch({ type: "next" })}>
						{strings.common.continue}
					</Button>
				</div>
			) : null}
			{state.step === "confirm" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						actions.confirm();
					}}
				>
					<h3 className="text-sm font-semibold">{strings.signup.confirmTitle}</h3>
					<p className="text-sm">{strings.signup.confirmHelp}</p>
					<Field label={strings.signup.confirmLabel}>
						<TextInput autoComplete="off" className="font-mono" value={state.typed} onChange={(e) => dispatch({ type: "typed_changed", typed: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<div className="flex gap-2">
						<Button type="submit" disabled={state.busy || !state.typed.trim()}>
							{state.busy ? strings.common.working : strings.signup.confirmTitle}
						</Button>
						<Button variant="link" onClick={() => dispatch({ type: "show_again" })}>
							{strings.signup.confirmBack}
						</Button>
					</div>
				</form>
			) : null}
			{state.step === "done" ? (
				<div className="flex flex-col gap-3">
					<h3 className="text-sm font-semibold">{strings.signup.doneTitle}</h3>
					<p className="text-sm">{strings.signup.doneHelp}</p>
					<Button onClick={onDone}>{strings.signup.doneButton}</Button>
				</div>
			) : null}
		</div>
	);
}

function PasswordStep({ state, dispatch, onSubmit }: { state: Extract<SignupState, { step: "password" }>; dispatch: Dispatch<SignupEvent>; onSubmit: () => void }) {
	const v = signupPasswordView(state);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		>
			<h3 className="text-sm font-semibold">{strings.signup.passwordTitle}</h3>
			<p className="text-sm">{strings.signup.passwordHelp}</p>
			<Field label={strings.signup.passwordLabel}>
				<TextInput type="password" autoComplete="new-password" value={state.password} onChange={(e) => dispatch({ type: "password_changed", password: e.target.value })} />
			</Field>
			<RuleList feedback={v.feedback} />
			<Field label={strings.signup.passwordConfirmLabel} error={v.mismatch ? strings.signup.passwordMismatch : undefined}>
				<TextInput type="password" autoComplete="new-password" value={state.confirm} onChange={(e) => dispatch({ type: "confirm_changed", confirm: e.target.value })} />
			</Field>
			<ErrorLine code={state.error} />
			<Button type="submit" disabled={!v.canSubmit}>
				{state.busy ? strings.common.working : strings.signup.createAccount}
			</Button>
		</form>
	);
}

/** Sign-up wired to the routes. `onDone` is called when the learner opens the app after the last step. */
export function SignUp({ api, onDone, initialEmail }: { api: VaultApi; onDone?: () => void; initialEmail?: string }) {
	const [state, dispatch] = useReducer(reduceSignup, initialEmail, initialSignup);
	const onBreach = useCallback((password: string, result: PasswordCheckResult) => dispatch({ type: "breach_result", password, result }), []);
	useBreachCheck(api, state.step === "password" ? state.password : "", state.step === "password" ? state.breach : null, onBreach);

	const run = async (fn: () => Promise<SignupEvent>) => {
		try {
			dispatch(await fn());
		} catch (e) {
			dispatch({ type: "failed", code: errorCode(e) });
		}
	};
	const actions: SignUpActions = {
		sendCode() {
			if (state.step !== "email") return;
			dispatch({ type: "submit_email" });
			void run(async () => (await api.signupStart({ email: state.email.trim() }), { type: "email_sent" }));
		},
		resendCode() {
			if (state.step !== "code") return;
			dispatch({ type: "resend_code" });
			void run(async () => (await api.signupStart({ email: state.email }), { type: "email_sent" }));
		},
		verify() {
			if (state.step !== "code") return;
			dispatch({ type: "submit_code" });
			void run(async () => (await api.signupVerify({ email: state.email, code: state.code.replace(/[\s-]/g, "").toUpperCase() }), { type: "code_verified" }));
		},
		createAccount() {
			if (state.step !== "password") return;
			dispatch({ type: "submit_password" });
			void run(async () => {
				const r = await api.signupFinish({ password: state.password });
				return { type: "finished", material: { recoveryKey: r.display.recoveryKey, backupCodes: r.display.backupCodes, kit: r.kit } };
			});
		},
		confirm() {
			if (state.step !== "confirm") return;
			dispatch({ type: "submit_confirm" });
			void run(async () => ({ type: "confirm_result", ok: (await api.signupConfirm({ typed: state.typed })).ok }));
		},
	};
	return <SignUpView state={state} dispatch={dispatch} actions={actions} {...(onDone ? { onDone } : {})} />;
}
