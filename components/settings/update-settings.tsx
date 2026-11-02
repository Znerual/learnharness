"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ReleaseNotesList, type UpdateNote } from "@/components/release-notes-list";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Observational snapshot from electron/main.cjs; never updater permission. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	/** What's new between the installed and the offered version (Vault builds; may be missing or empty). */
	notes?: UpdateNote[];
	revision: number;
};

export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
/** A Vault release's notes page (LH_RELEASE_NOTES_URL at build time); replaces the GitHub tag link. */
const RELEASE_NOTES_URL = process.env.LH_RELEASE_NOTES ?? "";
export const MANUAL_UPDATE_HINT = "Checking downloads available updates. Downloaded updates install when you quit the app.";
export const AUTO_UPDATE_HINT = "Check at startup and every 24 hours. Turning this off does not stop updates already in progress or ready to install.";
const UPDATE_ERROR = "Couldn’t check for updates. Try again later.";

/** Subscribe before requesting the snapshot. IPC replies and pushes can
 * cross; a revision prevents an older reply from hiding a newer event.
 * The banner shares this read-only observer so late loads recover too. */
export function useUpdateState() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const lh = window.lh;
		if (!lh) return;
		let live = true;
		let revision = -1;
		const accept = (next: UpdateState) => {
			if (!live || next.revision < revision) return;
			revision = next.revision;
			setState(next);
			setFailed(false);
		};
		const off = lh.onUpdateStatus?.(accept);
		void lh.getUpdateState?.().then(accept).catch(() => {
			if (live && revision === -1) setFailed(true);
		});
		return () => { live = false; off?.(); };
	}, []);
	return { state, failed };
}

/** The Android app's update check (learnharness-android AppUpdate, pro edition): `LHAndroid`
 * offers it, and the result comes back through `window.lhAndroidUpdate`. */
export type AndroidUpdateStatus = { status: "checking" | "up-to-date" | "available" | "error"; version?: string };
type AndroidUpdateWindow = {
	LHAndroid?: { updateCheckAvailable?: () => boolean; checkForUpdates?: () => void };
	lhAndroidUpdate?: (s: AndroidUpdateStatus) => void;
};

export function androidUpdateText(s: AndroidUpdateStatus | null): string | null {
	switch (s?.status) {
		case "checking": return "Checking for updates…";
		case "up-to-date": return "You have the latest version.";
		case "available": return `Version ${s.version ?? "?"} is available. Follow the prompt to install it.`;
		case "error": return UPDATE_ERROR;
		default: return null;
	}
}

export function useAndroidUpdate() {
	const [available, setAvailable] = useState(false);
	const [status, setStatus] = useState<AndroidUpdateStatus | null>(null);
	useEffect(() => {
		const w = window as unknown as AndroidUpdateWindow;
		try {
			setAvailable(!!w.LHAndroid?.checkForUpdates && w.LHAndroid.updateCheckAvailable?.() === true);
		} catch {
			setAvailable(false);
		}
		w.lhAndroidUpdate = (s) => setStatus(s);
		return () => { if (w.lhAndroidUpdate) delete w.lhAndroidUpdate; };
	}, []);
	const check = () => {
		setStatus({ status: "checking" });
		try {
			(window as unknown as AndroidUpdateWindow).LHAndroid?.checkForUpdates?.();
		} catch {
			setStatus({ status: "error" });
		}
	};
	return { available, status, check };
}

export function updateStatusText(state: UpdateState | null): string | null {
	switch (state?.status) {
		case "checking": return "Checking for updates…";
		case "downloading": return state.version ? `Downloading version ${state.version}…` : "Downloading an update…";
		case "up-to-date": return "No newer version was found at the last check.";
		case "downloaded": return `${state.version ? `Version ${state.version}` : "An update"} is ready. It will install when you quit the app.`;
		case "error": return UPDATE_ERROR;
		default: return null;
	}
}

/** Version information is useful everywhere; update controls only belong
 * to a shell with an available updater. Opening this row never checks. */
export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
	releaseNotesUrl = RELEASE_NOTES_URL,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
	releaseNotesUrl?: string;
}) {
	const { state, failed } = useUpdateState();
	const android = useAndroidUpdate();
	const [checkFailed, setCheckFailed] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = !active && android.available ? androidUpdateText(android.status)
		: state?.status === "downloaded" ? updateStatusText(state)
		: failed || checkFailed ? UPDATE_ERROR : updateStatusText(state);
	const releaseNotes = releaseNotesUrl || (version && homepage ? `${homepage}/releases/tag/v${version}` : null);
	const check = () => {
		setCheckFailed(false);
		void window.lh?.checkForUpdates?.().catch(() => setCheckFailed(true));
	};

	return (
		<>
			<SettingsRow
				label={`Version ${version || "unknown"}`}
				testid="row-version"
				hint={
					<>
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{active && <span className="block">{MANUAL_UPDATE_HINT}</span>}
						{active && (state.status === "downloading" || state.status === "downloaded") && state.notes && state.notes.length > 0 && (
							<details className="mt-1 block" data-testid="update-whats-new">
								<summary className="cursor-pointer text-foreground">What&apos;s new in {state.version ?? "this update"}</summary>
								<div className="mt-2 max-h-72 overflow-y-auto"><ReleaseNotesList notes={state.notes} /></div>
							</details>
						)}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
					</>
				}
			>
				{!active && android.available && (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={android.status?.status === "checking"} aria-busy={android.status?.status === "checking"} onClick={android.check}>
						{android.status?.status === "checking" && <BrailleSpinner label="Checking for updates" />}
						Check for updates
					</Button>
				)}
				{active && (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.lh?.installUpdate?.()}>Restart</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? "Downloading update" : "Checking for updates"} />}
						Check for updates
					</Button>
				))}
			</SettingsRow>
			{active && (
				<SettingsRow label="Automatic updates" hint={AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={autoUpdate} label="auto update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
		</>
	);
}
