"use client";

import { useEffect, useState } from "react";
import { useAndroidShell } from "@/components/android-shell";
import { CommitInput, SettingsRow, Toggle } from "./controls.tsx";

/** The device-name row (multi-device): what other devices show while this
 *  one runs a session ("running on Desktop"). Stored on this device only. */
export function DeviceSettings() {
	const [name, setName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void fetch("/api/device")
			.then((r) => r.json())
			.then((body: { device?: { name: string } }) => setName(body.device?.name ?? null))
			.catch(() => setError("Couldn’t load the device name."));
	}, []);
	const commit = async (next: string) => {
		if (!next) return; // an empty commit keeps the stored name
		const res = await fetch("/api/device", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }) });
		const body = (await res.json().catch(() => ({}))) as { device?: { name: string }; error?: string };
		if (res.ok && body.device) {
			setName(body.device.name);
			setError(null);
		} else setError(body.error ?? "Couldn’t save the device name.");
	};
	return (
		<SettingsRow label="Device name" hint={error ?? "Shown on your other devices while this one runs a session"} testid="device-name-row">
			<CommitInput value={name ?? ""} ariaLabel="Device name" testid="device-name" onCommit={(next) => void commit(next)} />
		</SettingsRow>
	);
}

/** The Android app's line for its data folder (learnharness-android MainActivity's PageBridge). */
interface AndroidDataBridge {
	/** "private" (the app's own folder) or "shared" (LearnHarness/data, reachable by a file-sync app). */
	dataLocation(): string;
	/** "" = the app restarts into the new folder; "permission" = Android asks for
	 *  "All files access" first; "busy" = work is running, try later. */
	setDataLocation(location: string): string;
}

const ANSWERS: Record<string, string> = {
	"": "Moving the data — the app restarts…",
	permission: "Allow “All files access” for LearnHarness; the data moves when you come back.",
	busy: "A turn or job is running — try again when it finishes.",
};

/**
 * Phone only (owner, 2026-11-01): where the Android app keeps the data
 * folder. Off — the app's own private folder, no special permission. On —
 * LearnHarness/data on the phone's storage, where a file-sync app can keep it
 * in sync with other devices; that needs "All files access", which Android
 * asks for when the switch turns on. Switching moves the data both ways and
 * restarts the app; turning it off copies the data back and leaves
 * LearnHarness/data as it is, since a file-sync app would carry its deletion
 * to the other devices.
 */
export function DataFolderSetting() {
	const android = useAndroidShell();
	const [shared, setShared] = useState<boolean | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const bridge = typeof window === "undefined" ? undefined : (window as { LHAndroid?: Partial<AndroidDataBridge> }).LHAndroid;
	useEffect(() => {
		if (android && bridge?.dataLocation) setShared(bridge.dataLocation() === "shared");
	}, [android, bridge]);
	if (!android || shared === null || !bridge?.setDataLocation) return null;
	const change = (next: boolean) => {
		const answer = bridge.setDataLocation!(next ? "shared" : "private");
		setNote(ANSWERS[answer] ?? answer);
	};
	return (
		<SettingsRow
			label="Sync data folder with other devices"
			hint={note ?? (shared
				? "Data lives in LearnHarness/data on this phone, where a file-sync app can keep it in sync with your other devices"
				: "Data stays in the app’s private folder. Turn on to keep it in LearnHarness/data for a file-sync app (asks for “All files access”)")}
			testid="data-folder-row"
		>
			<Toggle checked={shared} onChange={change} label="Sync data folder with other devices" />
		</SettingsRow>
	);
}
