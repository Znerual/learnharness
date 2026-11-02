"use client";

import type { Dispatch } from "react";
import type { VaultApi } from "@/src/core";
import { reauthMethodsLabel } from "./labels.ts";
import type { ReauthEvent, ReauthMethod, ReauthState } from "@/src/core";
import { strings } from "@/src/core";
import { runPasskeyReauth, runReauth } from "./hooks.ts";
import { Button, ErrorLine, Field, TextInput } from "./ui.tsx";

/** Pure view of the re-authentication step (ADR 0013). `onSubmit` performs the call. */
export function ReauthFormView({ state, dispatch, onSubmit, onPasskey }: { state: Extract<ReauthState, { step: "form" }>; dispatch: Dispatch<ReauthEvent>; onSubmit: () => void; onPasskey: () => void }) {
	const label = state.method === "password" ? strings.reauth.passwordLabel : strings.reauth.recoveryLabel;
	return (
		<form
			data-testid="reauth"
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit();
			}}
		>
			<h3 className="text-sm font-semibold">{strings.reauth.title}</h3>
			<p className="text-sm">{strings.reauth.help}</p>
			<div role="radiogroup" className="flex gap-3 text-sm">
				{state.available.map((m: ReauthMethod) => (
					<label key={m} className="flex items-center gap-1">
						<input type="radio" name="reauth-method" checked={state.method === m} onChange={() => dispatch({ type: "method_changed", method: m })} />
						{reauthMethodsLabel[m]}
					</label>
				))}
			</div>
			{state.method === "passkey" ? (
				<Button disabled={state.busy} onClick={onPasskey}>
					{state.busy ? strings.reauth.passkeyWorking : strings.reauth.withPasskey}
				</Button>
			) : (
				<>
					<Field label={label} help={state.method === "recovery" ? strings.reauth.recoveryWarning : undefined}>
						<TextInput
							type={state.method === "password" ? "password" : "text"}
							autoComplete={state.method === "password" ? "current-password" : "off"}
							value={state.value}
							onChange={(e) => dispatch({ type: "value_changed", value: e.target.value })}
						/>
					</Field>
					<Button type="submit" disabled={state.busy || !state.value.trim()}>
						{state.busy ? strings.common.working : strings.reauth.submit}
					</Button>
				</>
			)}
			<ErrorLine code={state.error} />
		</form>
	);
}

/** Re-authentication wired to the routes; reports the grant to the parent model through `dispatch`. */
export function ReauthForm({ api, state, dispatch }: { api: VaultApi; state: Extract<ReauthState, { step: "form" }>; dispatch: Dispatch<ReauthEvent> }) {
	return (
		<ReauthFormView
			state={state}
			dispatch={dispatch}
			onSubmit={() => {
				if (state.method === "passkey" || !state.value.trim()) return;
				dispatch({ type: "submit" });
				void runReauth(api, dispatch, state.method, state.value);
			}}
			onPasskey={() => {
				dispatch({ type: "passkey_started" });
				void runPasskeyReauth(api, dispatch);
			}}
		/>
	);
}
