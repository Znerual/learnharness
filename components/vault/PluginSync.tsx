"use client";

import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { errorCode, initialReauth, reduceReauth, type PluginSyncDto, type PluginSyncEntryDto, type ReauthEvent, type VaultApi } from "@/src/core";
import { strings } from "@/src/core";
import { ReauthForm } from "./ReauthForm.tsx";
import { Button, ErrorLine, Notice } from "./ui.tsx";

const t = strings.pluginSync;

/** "delete" asks to confirm; "reauth" then asks the learner to confirm it is them (ADR 0013). */
type Pending = { kind: "off" | "delete" | "reauth"; plugin: PluginSyncEntryDto } | null;

/** One plugin's row: what syncs, and the actions that apply to it (ADR 0007). */
export function PluginSyncRow({ plugin, busy, onSync, onDelete }: { plugin: PluginSyncEntryDto; busy: boolean; onSync: (enabled: boolean) => void; onDelete: () => void }) {
	const installed = plugin.enabled || plugin.sync || !plugin.inVault || plugin.identityMismatch;
	const state = plugin.overLimit
		? t.overLimit(plugin.overLimit)
		: !plugin.enabled && plugin.inVault && !installed
			? t.notInstalled
			: !plugin.enabled
				? t.disabledHere
				: plugin.sync
					? t.syncing
					: t.notSyncing;
	return (
		<li className="flex flex-col gap-1 py-2" data-testid={`plugin-sync-${plugin.origin}-${plugin.id}`}>
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="font-medium">{plugin.name}</span>
				<span className="text-xs text-muted-foreground">{plugin.origin === "core" ? t.core : t.community}</span>
			</div>
			<p className="text-xs text-muted-foreground">{state}</p>
			<div className="flex flex-wrap gap-2">
				{plugin.origin === "community" && plugin.enabled ? (
					<Button variant="secondary" disabled={busy} onClick={() => onSync(!plugin.sync)}>
						{plugin.sync ? t.turnOff : t.turnOn}
					</Button>
				) : null}
				{plugin.inVault && !(plugin.enabled && plugin.sync) ? (
					<Button variant="link" disabled={busy} onClick={onDelete}>
						{t.deleteData}
					</Button>
				) : null}
			</div>
		</li>
	);
}

/** Settings → Vault → Plugin data. */
export function PluginSyncView({ data, busy, error, pending, mismatch, onSync, onDelete, onConfirm, onCancel, onImportAnyway, reauthSlot }: {
	data: PluginSyncDto | null;
	busy: boolean;
	error: string | undefined;
	pending: Pending;
	mismatch: string | null;
	onSync: (plugin: PluginSyncEntryDto, enabled: boolean) => void;
	onDelete: (plugin: PluginSyncEntryDto) => void;
	onConfirm: () => void;
	onCancel: () => void;
	onImportAnyway: () => void;
	reauthSlot?: () => ReactNode;
}) {
	return (
		<section data-testid="plugin-sync" className="flex flex-col gap-3">
			<h2 className="text-lg font-semibold">{t.title}</h2>
			<p className="text-sm">{t.help}</p>
			{data && data.outdatedDevices.length > 0 ? <Notice tone="warning">{t.outdated(data.outdatedDevices.join(", "))}</Notice> : null}
			{data && data.conflicts > 0 ? <Notice tone="info">{t.conflicts(data.conflicts)}</Notice> : null}
			{mismatch ? (
				<Notice tone="warning" testid="plugin-sync-mismatch">
					<p>{t.identityMismatch}</p>
					<div className="mt-2 flex gap-2">
						<Button disabled={busy} onClick={onImportAnyway}>{t.importAnyway}</Button>
						<Button variant="secondary" onClick={onCancel}>{t.cancel}</Button>
					</div>
				</Notice>
			) : null}
			{pending?.kind === "reauth" ? (
				<Notice tone="warning" testid="plugin-sync-reauth">
					<p>{t.deleteReauth}</p>
					{reauthSlot?.()}
					<div className="mt-2 flex gap-2">
						<Button variant="secondary" onClick={onCancel}>{t.cancel}</Button>
					</div>
				</Notice>
			) : pending ? (
				<Notice tone="warning" testid="plugin-sync-confirm">
					<p>{pending.kind === "off" ? t.turnOffConfirm : t.deleteConfirm}</p>
					<div className="mt-2 flex gap-2">
						<Button disabled={busy} onClick={onConfirm}>{t.confirm}</Button>
						<Button variant="secondary" onClick={onCancel}>{t.cancel}</Button>
					</div>
				</Notice>
			) : null}
			<ul className="flex flex-col divide-y divide-border">
				{(data?.plugins ?? []).map((p) => (
					<PluginSyncRow key={`${p.origin}/${p.id}`} plugin={p} busy={busy} onSync={(enabled) => onSync(p, enabled)} onDelete={() => onDelete(p)} />
				))}
			</ul>
			<ErrorLine code={error} />
		</section>
	);
}

export function PluginSync({ api, passkeys = 0 }: { api: VaultApi; passkeys?: number }) {
	const [data, setData] = useState<PluginSyncDto | null>(null);
	// Each deletion needs a fresh grant: "reset" starts the form again.
	const [reauth, reauthDispatch] = useReducer((s: ReturnType<typeof initialReauth> | Parameters<typeof reduceReauth>[0], e: ReauthEvent | { type: "reset" }) => (e.type === "reset" ? initialReauth(passkeys) : reduceReauth(s, e)), undefined, () => initialReauth(passkeys));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [pending, setPending] = useState<Pending>(null);
	const [mismatch, setMismatch] = useState<string | null>(null);
	const run = useCallback(async (f: () => Promise<PluginSyncDto>) => {
		setBusy(true);
		setError(undefined);
		try {
			setData(await f());
		} catch (e) {
			setError(errorCode(e));
			throw e;
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		void run(() => api.pluginSyncList()).catch(() => undefined);
	}, [api, run]);
	// Re-authenticated: delete the plugin's data in the vault with the grant.
	const reauthId = pending?.kind === "reauth" && reauth.step === "granted" ? reauth.reauthId : null;
	useEffect(() => {
		if (!reauthId || pending?.kind !== "reauth") return;
		const p = pending.plugin;
		setPending(null);
		reauthDispatch({ type: "reset" });
		void run(() => api.pluginSyncDeleteData({ origin: p.origin, id: p.id, reauthId })).catch(() => undefined);
	}, [reauthId]);
	const turnOn = (id: string, confirmIdentity = false) =>
		run(() => api.pluginSyncSet({ id, enabled: true, confirmIdentity })).then(
			() => setMismatch(null),
			(e: unknown) => {
				if (errorCode(e) === "identity_mismatch") {
					setError(undefined);
					setMismatch(id);
				}
			},
		);
	return (
		<PluginSyncView
			data={data}
			busy={busy}
			error={error}
			pending={pending}
			mismatch={mismatch}
			onSync={(p, enabled) => (enabled ? void turnOn(p.id) : setPending({ kind: "off", plugin: p }))}
			onDelete={(p) => setPending({ kind: "delete", plugin: p })}
			onCancel={() => {
				setPending(null);
				reauthDispatch({ type: "reset" });
				setMismatch(null);
			}}
			onImportAnyway={() => mismatch && void turnOn(mismatch, true)}
			reauthSlot={() => (reauth.step === "form" ? <ReauthForm api={api} state={reauth} dispatch={(event: ReauthEvent) => reauthDispatch(event)} /> : null)}
			onConfirm={() => {
				const p = pending;
				if (!p) return;
				if (p.kind === "delete") {
					setPending({ kind: "reauth", plugin: p.plugin });
					return;
				}
				setPending(null);
				void run(() => api.pluginSyncSet({ id: p.plugin.id, enabled: false })).catch(() => undefined);
			}}
		/>
	);
}
