"use client";

import { useCallback, useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import type { ReauthEvent } from "@/src/core";
import { canAddPasskey, initialPasskeys, passkeyCallReady, passkeyNoticeText, reauthPasskeys, reducePasskeys, validPasskeyName, type PasskeysEvent, type PasskeysState } from "@/src/core";
import { strings } from "@/src/core";
import { ReauthForm } from "./ReauthForm.tsx";
import { Button, ErrorLine, Field, Notice, TextInput } from "./ui.tsx";

export interface PasskeysActions {
	/** Continue from the name step to re-authentication. */
	continueAdd(): void;
}

/**
 * Pure view of the passkey list with add and remove. Where the ceremony cannot run (web, dev) the
 * list and removal still work and "Add" is replaced by the reason, in plain words.
 */
export function PasskeysView({ state, dispatch, actions, reauthSlot }: { state: PasskeysState; dispatch: Dispatch<PasskeysEvent>; actions: PasskeysActions; reauthSlot?: () => ReactNode }) {
	const a = state.action;
	return (
		<section data-testid="passkeys" className="flex flex-col gap-3">
			<header>
				<h2 className="text-lg font-semibold">{strings.passkeys.title}</h2>
				<p className="text-sm text-muted-foreground">{strings.passkeys.intro}</p>
			</header>
			{state.notice ? (
				<Notice tone="ok" testid="passkeys-notice">
					{passkeyNoticeText(state.notice)}
				</Notice>
			) : null}
			<ErrorLine code={state.error} />
			<ul className="flex flex-col gap-2">
				{state.rows.map((p) => (
					<li key={p.id} data-testid="passkey" data-passkey-id={p.id} data-sign-in-only={p.signInOnly ? "true" : "false"} className="flex flex-col gap-1 rounded-md border border-border p-3">
						<p className="text-sm font-medium">{p.name}</p>
						<p className="text-xs text-muted-foreground">{p.signInOnly ? strings.passkeys.signInOnly : strings.passkeys.unlocks}</p>
						{p.signInOnly ? <p className="text-xs text-muted-foreground">{strings.passkeys.signInOnlyHelp}</p> : null}
						<div>
							<Button variant="link" disabled={state.busy} onClick={() => dispatch({ type: "remove_ask", id: p.id })}>
								{strings.passkeys.remove}
							</Button>
						</div>
					</li>
				))}
				{state.rows.length === 0 ? <li className="text-sm text-muted-foreground">{strings.passkeys.none}</li> : null}
			</ul>
			{a === null && canAddPasskey(state) ? (
				<div>
					<Button variant="secondary" onClick={() => dispatch({ type: "add_start" })}>
						{strings.passkeys.add}
					</Button>
				</div>
			) : null}
			{state.availability && !state.availability.available ? (
				<p data-testid="passkeys-unavailable" className="text-xs text-muted-foreground">
					{strings.passkeys.unavailable[state.availability.reason]}
				</p>
			) : null}
			{a?.kind === "add" && a.step === "name" ? (
				<form
					data-testid="passkey-add"
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						actions.continueAdd();
					}}
				>
					<Field label={strings.passkeys.nameLabel} help={strings.passkeys.nameHelp}>
						<TextInput value={a.name} maxLength={64} onChange={(e) => dispatch({ type: "name_changed", name: e.target.value })} />
					</Field>
					<div className="flex gap-2">
						<Button type="submit" disabled={!validPasskeyName(a.name)}>
							{strings.common.continue}
						</Button>
						<Button variant="secondary" onClick={() => dispatch({ type: "cancel" })}>
							{strings.common.cancel}
						</Button>
					</div>
				</form>
			) : null}
			{a?.kind === "add" && a.step === "reauth" ? (
				<Notice title={strings.passkeys.add} testid="passkey-add-reauth">
					{a.reauth.step === "form" ? reauthSlot?.() : <p>{state.busy ? strings.passkeys.adding : strings.common.working}</p>}
					<Button variant="link" disabled={state.busy} onClick={() => dispatch({ type: "cancel" })}>
						{strings.common.cancel}
					</Button>
				</Notice>
			) : null}
			{a?.kind === "remove" ? (
				<Notice tone="warning" title={strings.passkeys.removeTitle(a.passkey.name)} testid="passkey-remove">
					<p>{a.passkey.signInOnly ? strings.passkeys.removeSignInOnly : strings.passkeys.removeUnlocks}</p>
					{a.reauth.step === "form" ? reauthSlot?.() : <p>{strings.common.working}</p>}
					<Button variant="link" disabled={state.busy} onClick={() => dispatch({ type: "cancel" })}>
						{strings.common.cancel}
					</Button>
				</Notice>
			) : null}
		</section>
	);
}

/** Passkeys wired to the routes. `onChanged` runs after an add or remove (the account's passkey count changed). */
export function Passkeys({ api, onChanged }: { api: VaultApi; onChanged?: () => void }) {
	const [state, dispatch] = useReducer(reducePasskeys, undefined, initialPasskeys);
	const load = useCallback(async () => {
		try {
			const [list, account] = await Promise.all([api.passkeys(), api.account()]);
			dispatch({ type: "loaded", rows: list.passkeys, availability: list.availability, reauthPasskeys: reauthPasskeys(account) });
		} catch (e) {
			dispatch({ type: "failed", code: errorCode(e) });
		}
	}, [api]);
	useEffect(() => {
		void load();
	}, [load]);

	// when the add or remove dialog holds a fresh grant, make the one call
	const ready = passkeyCallReady(state);
	useEffect(() => {
		if (!ready) return;
		dispatch({ type: "submitted" });
		if (ready.op === "add") {
			api.passkeyRegister({ name: ready.name, reauthId: ready.reauthId })
				.then((row) => {
					dispatch({ type: "added", row });
					onChanged?.();
				})
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		} else {
			api.passkeyRemove({ passkeyId: ready.passkeyId, reauthId: ready.reauthId })
				.then((outcome) => {
					dispatch({ type: "removed", outcome });
					onChanged?.();
					return load();
				})
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		}
	}, [ready?.op, ready?.reauthId]);

	const a = state.action;
	return (
		<PasskeysView
			state={state}
			dispatch={dispatch}
			actions={{ continueAdd: () => dispatch({ type: "name_continue" }) }}
			reauthSlot={() =>
				a && ((a.kind === "add" && a.step === "reauth") || a.kind === "remove") && a.reauth.step === "form" ? (
					<ReauthForm api={api} state={a.reauth} dispatch={(event: ReauthEvent) => dispatch({ type: "reauth", event })} />
				) : null
			}
		/>
	);
}
