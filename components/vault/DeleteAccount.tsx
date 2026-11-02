"use client";

import { useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { deleteCallReady, emailMatches, initialDeleteAccount, reduceDeleteAccount, type DeleteAccountEvent, type DeleteAccountState } from "@/src/core";
import { strings } from "@/src/core";
import { saveBase64File } from "./ExportReminder.tsx";
import { ReauthForm } from "./ReauthForm.tsx";
import { Button, ErrorLine, Field, Notice, TextInput } from "./ui.tsx";

export interface DeleteAccountActions {
	exportFirst(): void;
}

/** Pure view of the four steps: export offer, type the email, re-authenticate, done. */
export function DeleteAccountView({ state, email, dispatch, actions, reauthSlot }: { state: DeleteAccountState; email: string; dispatch: Dispatch<DeleteAccountEvent>; actions: DeleteAccountActions; reauthSlot?: () => ReactNode }) {
	return (
		<section data-testid="delete-account" data-step={state.step} className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold text-red-600">{strings.delete.title}</h2>
			{state.step !== "done" ? <p className="text-sm">{strings.delete.warning}</p> : null}
			{state.step === "export" ? (
				<>
					<h3 className="text-sm font-semibold">{strings.delete.exportFirst}</h3>
					<p className="text-sm">{strings.delete.exportFirstHelp}</p>
					<div className="flex flex-wrap gap-2">
						<Button disabled={state.busy} onClick={actions.exportFirst}>
							{state.busy ? strings.export.downloading : strings.delete.exportFirst}
						</Button>
						<Button variant="secondary" disabled={state.busy} onClick={() => dispatch({ type: "continue" })}>
							{state.exported ? strings.delete.continue : strings.delete.skipExport}
						</Button>
					</div>
					{state.exported ? <Notice tone="ok">{strings.delete.exported}</Notice> : null}
					<ErrorLine code={state.error} />
				</>
			) : null}
			{state.step === "email" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						dispatch({ type: "continue" });
					}}
				>
					<Field label={strings.delete.emailLabel(email)} error={state.typed && !emailMatches(state.typed, email) ? strings.delete.emailMismatch : undefined}>
						<TextInput type="email" autoComplete="off" value={state.typed} onChange={(e) => dispatch({ type: "typed_changed", typed: e.target.value })} />
					</Field>
					<Button type="submit" variant="danger" disabled={!emailMatches(state.typed, email)}>
						{strings.delete.continue}
					</Button>
				</form>
			) : null}
			{state.step === "reauth" ? (
				<>
					<p className="text-sm">{strings.delete.reauthHelp}</p>
					{state.reauth.step === "form" ? reauthSlot?.() : <p className="text-sm">{state.submitted ? strings.delete.working : strings.delete.submit}</p>}
					<ErrorLine code={state.error} />
				</>
			) : null}
			{state.step === "done" ? <Notice tone="ok" testid="delete-done">{strings.delete.done}</Notice> : null}
		</section>
	);
}

/** Delete account wired to the routes. `email` is the signed-in account's address; `onDeleted` runs after. */
export function DeleteAccount({ api, email, passkeys = 0, onDeleted }: { api: VaultApi; email: string; passkeys?: number; onDeleted: () => void }) {
	const [state, dispatch] = useReducer((s: DeleteAccountState, e: DeleteAccountEvent) => reduceDeleteAccount(s, e, email, passkeys), initialDeleteAccount);
	const reauthId = deleteCallReady(state);
	useEffect(() => {
		if (!reauthId) return;
		dispatch({ type: "submitted" });
		api.deleteAccount({ email, reauthId })
			.then(() => {
				dispatch({ type: "deleted" });
				onDeleted();
			})
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	}, [reauthId]);
	return (
		<DeleteAccountView
			state={state}
			email={email}
			dispatch={dispatch}
			actions={{
				exportFirst() {
					dispatch({ type: "export_start" });
					api.exportDownload()
						.then((r) => {
							saveBase64File(r);
							dispatch({ type: "export_done" });
						})
						.catch((e) => dispatch({ type: "export_failed", code: errorCode(e) }));
				},
			}}
			reauthSlot={() => (state.step === "reauth" && state.reauth.step === "form" ? <ReauthForm api={api} state={state.reauth} dispatch={(event) => dispatch({ type: "reauth", event })} /> : null)}
		/>
	);
}
