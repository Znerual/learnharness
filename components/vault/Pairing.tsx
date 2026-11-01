"use client";

import { useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import { errorCode, type VaultApi } from "@/src/core";
import { formatPairingCode, formatPairingText, initialApprover, initialJoiner, joinCallReady, reduceApprover, reduceJoiner, type ApproverEvent, type ApproverState, type JoinerEvent, type JoinerState } from "@/src/core";
import { strings } from "@/src/core";
import { androidScannerAvailable, startAndroidScan } from "./android-scan.ts";
import { Button, ErrorLine, Field, Notice, QrSvg, SecretBlock, TextInput } from "./ui.tsx";

// ---------------------------------------------------------------- approver (signed-in device)

export function PairingApproverView({ state, dispatch, onStart, onApprove }: { state: ApproverState; dispatch: Dispatch<ApproverEvent>; onStart: () => void; onApprove: () => void }) {
	return (
		<section data-testid="pairing-approver" data-step={state.step} className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold">{strings.pairing.showTitle}</h2>
			{state.step === "idle" ? (
				<>
					<p className="text-sm">{strings.pairing.showHelp}</p>
					<ErrorLine code={state.error} />
					<Button disabled={state.busy} onClick={onStart}>
						{state.busy ? strings.common.working : strings.pairing.showTitle}
					</Button>
				</>
			) : null}
			{state.step === "showing" ? (
				<>
					<p className="text-sm">{strings.pairing.showHelp}</p>
					<QrSvg value={state.qr} />
					<SecretBlock testid="pairing-text" label={strings.pairing.textLabel} value={formatPairingText(state.text)} />
					<p className="text-xs text-muted-foreground">{strings.pairing.expires}</p>
					<p className="text-sm" aria-live="polite">
						{strings.pairing.waiting}
					</p>
					<Button variant="link" onClick={() => dispatch({ type: "reject" })}>
						{strings.common.cancel}
					</Button>
				</>
			) : null}
			{state.step === "review" ? (
				<>
					<h3 className="text-sm font-semibold">{strings.pairing.reviewTitle}</h3>
					<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
						<dt className="font-medium">{strings.pairing.reviewName}</dt>
						<dd data-testid="pairing-device-name">{state.deviceName}</dd>
						<dt className="font-medium">{strings.pairing.reviewCode}</dt>
						<dd data-testid="pairing-code" className="font-mono text-2xl tracking-widest">
							{formatPairingCode(state.code)}
						</dd>
					</dl>
					<p className="text-sm">{strings.pairing.reviewHelp}</p>
					<ErrorLine code={state.error} />
					<div className="flex gap-2">
						<Button disabled={state.busy} onClick={onApprove}>
							{state.busy ? strings.pairing.approving : strings.pairing.approve}
						</Button>
						<Button variant="danger" disabled={state.busy} onClick={() => dispatch({ type: "reject" })}>
							{strings.pairing.reject}
						</Button>
					</div>
				</>
			) : null}
			{state.step === "approved" ? <Notice tone="ok" testid="pairing-approved">{strings.pairing.approved}</Notice> : null}
			{state.step === "cancelled" ? <Notice testid="pairing-cancelled">{strings.pairing.cancelled}</Notice> : null}
			{state.step === "failed" ? (
				<Notice tone="error" testid="pairing-failed">
					{state.error === "pairing_timeout" ? strings.pairing.timeout : <ErrorLine code={state.error} />}
				</Notice>
			) : null}
		</section>
	);
}

/** Approver wired to the routes: show, wait for the join, review, approve. */
export function PairingApprover({ api }: { api: VaultApi }) {
	const [state, dispatch] = useReducer(reduceApprover, initialApprover);
	const pairingId = state.step === "showing" ? state.pairingId : null;
	useEffect(() => {
		if (!pairingId) return;
		let live = true;
		api.pairReview({ pairingId })
			.then((r) => live && dispatch({ type: "reviewed", name: r.name, code: r.code }))
			.catch((e) => live && dispatch({ type: "failed", code: errorCode(e) }));
		return () => {
			live = false;
		};
	}, [api, pairingId]);
	return (
		<PairingApproverView
			state={state}
			dispatch={(e) => {
				if (e.type === "reject" && "pairingId" in state) void api.pairCancel({ pairingId: state.pairingId }).catch(() => undefined);
				dispatch(e);
			}}
			onStart={() => {
				dispatch({ type: "start" });
				api.pairShow()
					.then((r) => dispatch({ type: "shown", ...r }))
					.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
			}}
			onApprove={() => {
				if (state.step !== "review") return;
				dispatch({ type: "approve" });
				api.pairApprove({ pairingId: state.pairingId })
					.then(() => dispatch({ type: "approved" }))
					.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
			}}
		/>
	);
}

// ---------------------------------------------------------------- joiner (new device)

/** `onScan` is given only where the app has a camera scanner (Android); everywhere else the code is pasted or typed. */
export function PairingJoinerView({ state, dispatch, onShow, onJoin, onScan }: { state: JoinerState; dispatch: Dispatch<JoinerEvent>; onShow: () => void; onJoin: () => void; onScan?: () => void }) {
	return (
		<section data-testid="pairing-joiner" data-step={state.step} className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold">{strings.pairing.joinerTitle}</h2>
			{state.step === "choose" ? (
				<>
					{onScan ? (
						<Button disabled={state.busy} onClick={onScan}>
							{strings.scan.button}
						</Button>
					) : null}
					<Button variant={onScan ? "secondary" : "primary"} disabled={state.busy} onClick={onShow}>
						{state.busy ? strings.common.working : strings.pairing.showTitle}
					</Button>
					<Button variant="secondary" onClick={() => dispatch({ type: "scan_mode" })}>
						{strings.pairing.joinerScanLabel}
					</Button>
					<ErrorLine code={state.error} />
				</>
			) : null}
			{state.step === "showing" ? (
				<>
					<p className="text-sm">{strings.pairing.joinerShowHelp}</p>
					<QrSvg value={state.qr} />
					<SecretBlock testid="pairing-text" label={strings.pairing.textLabel} value={formatPairingText(state.text)} />
					<JoinerCode code={state.code} />
					<p className="text-sm" aria-live="polite">
						{strings.pairing.joinerWaiting}
					</p>
				</>
			) : null}
			{state.step === "scan" ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						onJoin();
					}}
				>
					{onScan ? (
						<Button disabled={state.busy || state.scanning} onClick={onScan}>
							{state.scanning ? strings.scan.scanning : strings.scan.button}
						</Button>
					) : null}
					<Field label={strings.pairing.joinerScanLabel} help={onScan ? strings.scan.pasteHelp : strings.pairing.joinerScanHelp}>
						<TextInput className="font-mono" autoComplete="off" value={state.value} onChange={(e) => dispatch({ type: "value_changed", value: e.target.value })} />
					</Field>
					<ErrorLine code={state.error} />
					<Button type="submit" disabled={state.busy}>
						{state.busy ? strings.common.working : strings.pairing.joinerJoin}
					</Button>
				</form>
			) : null}
			{state.step === "waiting" ? (
				<>
					<JoinerCode code={state.code} />
					<p className="text-sm" aria-live="polite">
						{strings.pairing.joinerWaiting}
					</p>
				</>
			) : null}
			{state.step === "done" ? <Notice tone="ok" testid="pairing-joined">{strings.pairing.joinerDone}</Notice> : null}
			{state.step === "failed" ? (
				<Notice tone="error" testid="pairing-failed">
					{state.error === "pairing_timeout" ? strings.pairing.timeout : <ErrorLine code={state.error} />}
				</Notice>
			) : null}
		</section>
	);
}

function JoinerCode({ code }: { code: string }) {
	return (
		<div>
			<p className="text-sm font-medium">{strings.pairing.joinerCodeLabel}</p>
			<p data-testid="pairing-code" className="font-mono text-2xl tracking-widest">
				{formatPairingCode(code)}
			</p>
			<p className="text-xs text-muted-foreground">{strings.pairing.joinerCodeHelp}</p>
		</div>
	);
}

/** Joiner wired to the routes. `onJoined` runs when this device holds the keys and is signed in. */
export function PairingJoiner({ api, onJoined }: { api: VaultApi; onJoined: () => void }) {
	const [state, dispatch] = useReducer(reduceJoiner, initialJoiner);
	const waitingFor = state.step === "showing" || state.step === "waiting" ? state.pairingId : null;
	// the Android app's camera scanner, when this page runs inside it
	const [canScan, setCanScan] = useState(false);
	const stopScan = useRef<(() => void) | null>(null);
	useEffect(() => {
		setCanScan(androidScannerAvailable());
		return () => stopScan.current?.();
	}, []);
	// the join call for a typed or scanned code, once
	const code = joinCallReady(state);
	useEffect(() => {
		if (code === null) return;
		api.pairJoin({ code })
			.then((r) => dispatch({ type: "joined", ...r }))
			.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
	}, [api, code]);
	useEffect(() => {
		if (!waitingFor) return;
		let live = true;
		api.pairFinish({ pairingId: waitingFor })
			.then(() => {
				if (!live) return;
				dispatch({ type: "finished" });
				onJoined();
			})
			.catch((e) => live && dispatch({ type: "failed", code: errorCode(e) }));
		return () => {
			live = false;
		};
	}, [api, waitingFor, onJoined]);
	return (
		<PairingJoinerView
			state={state}
			dispatch={dispatch}
			onShow={() => {
				dispatch({ type: "show_own" });
				api.pairJoinerShow()
					.then((r) => dispatch({ type: "shown", ...r }))
					.catch((e) => dispatch({ type: "failed", code: errorCode(e) }));
			}}
			onJoin={() => dispatch({ type: "join" })}
			{...(canScan
				? {
						onScan: () => {
							stopScan.current?.();
							dispatch({ type: "scan_started" });
							stopScan.current = startAndroidScan((r) => dispatch(r.ok && r.payload ? { type: "scanned", payload: r.payload } : { type: "scan_failed", ...(r.reason === undefined ? {} : { reason: r.reason }) }));
						},
					}
				: {})}
		/>
	);
}
