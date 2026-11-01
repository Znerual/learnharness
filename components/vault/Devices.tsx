"use client";

import { useCallback, useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { formatDateTime } from "@/src/core";
import { deviceView, initialDevices, pendingCallReady, pendingView, reduceDevices, revokeCallReady, sortedDevices, type DevicesEvent, type DevicesState } from "@/src/core";
import type { ReauthEvent } from "@/src/core";
import { strings } from "@/src/core";
import { ReauthForm } from "./ReauthForm.tsx";
import { Button, ErrorLine, Field, Notice, TextInput } from "./ui.tsx";

export interface DevicesActions {
	renameSubmit(): void;
	signOut(): void;
	confirmPending(): void;
	cancelPending(): void;
	addDevice(): void;
}

function noticeText(n: NonNullable<DevicesState["notice"]>): string {
	switch (n.kind) {
		case "revoked":
			return strings.devices.revokeApplied(n.name);
		case "revoke_pending":
			return strings.devices.revokePending(n.name, formatDateTime(n.runsAt));
		case "signed_out":
			return strings.devices.noticeSignedOut;
		case "pending_confirmed":
			return strings.devices.noticeConfirmed;
		case "pending_cancelled":
			return strings.devices.noticeCancelled;
	}
}

/** Pure view. `reauthSlot` renders the re-authentication form (wired by `Devices`, a stub in tests). */
export function DevicesView({ state, dispatch, actions, now, reauthSlot }: { state: DevicesState; dispatch: Dispatch<DevicesEvent>; actions: DevicesActions; now: Date; reauthSlot?: () => ReactNode }) {
	const rows = sortedDevices(state.devices);
	const pending = state.pending ? pendingView(state.pending, state.devices, now) : null;
	return (
		<section data-testid="devices" className="flex flex-col gap-4">
			<header className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold">{strings.devices.title}</h2>
					<p className="text-sm text-muted-foreground">{strings.devices.intro}</p>
				</div>
				<Button variant="secondary" onClick={actions.addDevice}>
					{strings.devices.pair}
				</Button>
			</header>
			{state.notice ? <Notice tone="ok" testid="devices-notice">{noticeText(state.notice)}</Notice> : null}
			<ErrorLine code={state.error} />
			{pending ? (
				<Notice tone="warning" title={strings.devices.pendingTitle} testid="pending-action">
					<p>{pending.title}</p>
					<p>{pending.requestedBy}</p>
					<p>{pending.runs}</p>
					<div className="mt-2 flex gap-2">
						{pending.canConfirm ? (
							<Button disabled={state.busy} onClick={actions.confirmPending}>
								{strings.devices.pendingConfirm}
							</Button>
						) : null}
						{pending.canCancel ? (
							<Button variant="secondary" disabled={state.busy} onClick={actions.cancelPending}>
								{strings.devices.pendingCancel}
							</Button>
						) : null}
					</div>
					{pending.notes.map((n) => (
						<p key={n} className="text-xs text-muted-foreground">
							{n}
						</p>
					))}
				</Notice>
			) : null}
			<ul className="flex flex-col gap-3">
				{rows.map((d) => {
					const v = deviceView(d, now, state.rename?.deviceId === d.id);
					return (
						<li key={d.id} data-testid="device" data-device-id={d.id} data-current={d.current ? "true" : "false"} className="flex flex-col gap-1 rounded-md border border-border p-3">
							{v.renaming && state.rename ? (
								<form
									className="flex items-end gap-2"
									onSubmit={(e) => {
										e.preventDefault();
										actions.renameSubmit();
									}}
								>
									<Field label={strings.devices.renameLabel}>
										<TextInput value={state.rename.value} maxLength={64} onChange={(e) => dispatch({ type: "rename_changed", value: e.target.value })} />
									</Field>
									<Button type="submit" disabled={state.busy}>
										{strings.common.save}
									</Button>
									<Button variant="link" onClick={() => dispatch({ type: "rename_cancel" })}>
										{strings.common.cancel}
									</Button>
								</form>
							) : (
								<p className="text-sm font-medium">{v.name}</p>
							)}
							<ul className="flex flex-wrap gap-1 text-xs">
								{v.badges.map((b) => (
									<li key={b.id} data-badge={b.id} title={b.help} className="rounded-full border border-border px-2 py-0.5">
										{b.label}
									</li>
								))}
							</ul>
							<p className="text-xs text-muted-foreground">{v.meta.join(" · ")}</p>
							<div className="flex gap-3">
								{v.actions.includes("rename") ? (
									<Button variant="link" onClick={() => dispatch({ type: "rename_start", deviceId: d.id })}>
										{strings.devices.rename}
									</Button>
								) : null}
								{v.actions.includes("sign_out") ? (
									<Button variant="link" onClick={() => dispatch({ type: "sign_out_ask" })}>
										{strings.devices.signOut}
									</Button>
								) : null}
								{v.actions.includes("revoke") ? (
									<Button variant="link" onClick={() => dispatch({ type: "revoke_ask", deviceId: d.id })}>
										{strings.devices.revoke}
									</Button>
								) : null}
							</div>
							{v.actions.includes("sign_out") ? <p className="text-xs text-muted-foreground">{strings.devices.signOutHelp}</p> : null}
							{v.actions.includes("revoke") ? <p className="text-xs text-muted-foreground">{strings.devices.revokeHelp}</p> : null}
						</li>
					);
				})}
				{rows.length <= 1 ? <li className="text-sm text-muted-foreground">{strings.devices.empty}</li> : null}
			</ul>
			{state.action?.kind === "sign_out_confirm" ? (
				<Notice tone="warning" title={strings.devices.signOutConfirm} testid="sign-out-confirm">
					<p>{strings.devices.signOutConfirmBody}</p>
					<div className="mt-2 flex gap-2">
						<Button variant="danger" disabled={state.busy} onClick={actions.signOut}>
							{strings.devices.signOut}
						</Button>
						<Button variant="secondary" onClick={() => dispatch({ type: "action_cancel" })}>
							{strings.common.cancel}
						</Button>
					</div>
				</Notice>
			) : null}
			{state.action?.kind === "revoke" ? (
				<Notice tone="warning" title={strings.devices.revokeConfirmTitle(state.action.name)} testid="revoke-confirm">
					<p>{strings.devices.revokeConfirmBody}</p>
					{state.action.reauth.step === "form" ? reauthSlot?.() : <p>{strings.common.working}</p>}
					<Button variant="link" disabled={state.busy} onClick={() => dispatch({ type: "action_cancel" })}>
						{strings.common.cancel}
					</Button>
				</Notice>
			) : null}
			{state.action?.kind === "pending" ? (
				<Notice tone="warning" title={state.action.op === "confirm" ? strings.devices.pendingConfirmTitle : strings.devices.pendingCancelTitle} testid="pending-reauth">
					{state.action.op === "confirm" ? <p>{strings.devices.pendingConfirmStrong}</p> : null}
					{state.action.reauth.step === "form" ? reauthSlot?.() : <p>{strings.common.working}</p>}
					<Button variant="link" disabled={state.busy} onClick={() => dispatch({ type: "action_cancel" })}>
						{strings.common.cancel}
					</Button>
				</Notice>
			) : null}
		</section>
	);
}

/** Devices wired to the routes. `onAddDevice` opens the Pairing screen; `onSignedOut` runs after sign-out. */
export function Devices({ api, onAddDevice, onSignedOut, now = () => new Date() }: { api: VaultApi; onAddDevice: () => void; onSignedOut: () => void; now?: () => Date }) {
	const [state, dispatch] = useReducer(reduceDevices, undefined, initialDevices);
	const load = useCallback(async () => {
		try {
			const [d, a] = await Promise.all([api.devices(), api.account()]);
			dispatch({ type: "loaded", devices: d.devices, pending: d.pendingAction, passkeys: a.passkeys });
		} catch (e) {
			dispatch({ type: "failed", code: errorCode(e) });
		}
	}, [api]);
	useEffect(() => {
		void load();
	}, [load]);

	// when the revoke dialog holds a fresh grant, make the one call
	const ready = revokeCallReady(state);
	useEffect(() => {
		if (!ready) return;
		dispatch({ type: "revoke_submitted" });
		api.revokeDevice(ready)
			.then((outcome) => {
				dispatch({ type: "revoke_result", outcome });
				return load();
			})
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	}, [ready?.deviceId, ready?.reauthId]);

	const pendingReady = pendingCallReady(state);
	useEffect(() => {
		if (!pendingReady) return;
		dispatch({ type: "pending_submitted" });
		const { op, id, reauthId } = pendingReady;
		(op === "confirm" ? api.confirmPending({ id, reauthId }) : api.cancelPending({ id, reauthId }))
			.then(() => {
				dispatch({ type: "pending_done", kind: op === "confirm" ? "confirmed" : "cancelled" });
				return load();
			})
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	}, [pendingReady?.id, pendingReady?.reauthId]);

	const actions: DevicesActions = {
		renameSubmit() {
			if (!state.rename) return;
			const { deviceId, value } = state.rename;
			dispatch({ type: "rename_submit" });
			api.renameDevice({ deviceId, name: value.trim() })
				.then(() => {
					dispatch({ type: "rename_done" });
					return load();
				})
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		},
		signOut() {
			api.signOut()
				.then(() => {
					dispatch({ type: "sign_out_done" });
					onSignedOut();
				})
				.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
		},
		confirmPending() {
			if (!state.pending) return;
			dispatch({ type: "pending_confirm" });
		},
		cancelPending() {
			if (!state.pending) return;
			dispatch({ type: "pending_cancel" });
		},
		addDevice: onAddDevice,
	};
	const a = state.action;
	return (
		<DevicesView
			state={state}
			dispatch={dispatch}
			actions={actions}
			now={now()}
			reauthSlot={() =>
				(a?.kind === "revoke" || a?.kind === "pending") && a.reauth.step === "form" ? (
					<ReauthForm api={api} state={a.reauth} dispatch={(event: ReauthEvent) => dispatch({ type: "reauth", event })} />
				) : null
			}
		/>
	);
}
