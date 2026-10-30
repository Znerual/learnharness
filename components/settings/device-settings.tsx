"use client";

import { useEffect, useState } from "react";
import { CommitInput, SettingsRow } from "./controls.tsx";

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
