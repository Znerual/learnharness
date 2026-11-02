"use client";

import { useEffect, useState } from "react";

/** Asked once per page load; null until answered. */
let answer: Promise<boolean> | null = null;

/** Whether the vault can be used here: a vault server is configured (LH_VAULT_URL) and the private
 *  client package is installed. False in every public build, and until the server has answered. */
export function useVaultAvailable(): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		answer ??= fetch("/api/vault/available")
			.then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
			.then((body) => body.available === true)
			.catch(() => false);
		let live = true;
		void answer.then((a) => live && setAvailable(a));
		return () => {
			live = false;
		};
	}, []);
	return available;
}
