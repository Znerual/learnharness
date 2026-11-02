"use client";

import { useEffect, useReducer } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { initialUnlock, reduceUnlock, unlockView, type UnlockState } from "@/src/core";
import { strings } from "@/src/core";
import { Button, ErrorLine, Notice } from "./ui.tsx";

export function UnlockView({ state, onAction }: { state: UnlockState; onAction: (a: "sign_in" | "retry" | "unlock" | "set_password") => void }) {
	const v = unlockView(state);
	if (v.appUsable && !v.body) return null; // normal launch: nothing to say
	return (
		<div data-testid="unlock" data-step={state.step} className="flex flex-col gap-3">
			{v.appUsable ? (
				<Notice tone="info" title={v.title} testid="unlock-notice">
					<p>{v.body}</p>
				</Notice>
			) : (
				<>
					<h2 className="text-lg font-semibold">{v.title}</h2>
					{v.body ? <p className="text-sm">{v.body}</p> : null}
					{state.step === "failed" ? <ErrorLine code={state.error} /> : null}
					{v.action ? (
						<Button onClick={() => onAction(v.action!)}>
							{v.action === "sign_in" ? strings.unlock.signInAgain : v.action === "retry" ? strings.common.retry : v.action === "unlock" ? strings.signin.unlockButton : strings.recover.newPasswordSubmit}
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}

/**
 * Runs `open` on launch (the server process unlocks from secure storage). `onReady` fires when the
 * app can be used; `onNeeds` routes to Sign in, the unlock choices or the forced new password.
 */
export function Unlock({ api, onReady, onNeeds }: { api: VaultApi; onReady: () => void; onNeeds: (screen: "sign_in" | "unlock" | "set_password") => void }) {
	const [state, dispatch] = useReducer(reduceUnlock, initialUnlock);
	const open = () => {
		api.open()
			.then((session) => dispatch({ type: "session", session }))
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	};
	useEffect(open, [api]);
	useEffect(() => {
		if (state.step === "ready") onReady();
	}, [state, onReady]);
	return (
		<UnlockView
			state={state}
			onAction={(a) => {
				if (a === "retry") {
					dispatch({ type: "session", session: { state: "signed_out" } });
					open();
				} else onNeeds(a);
			}}
		/>
	);
}
