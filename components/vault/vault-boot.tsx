"use client";

import { useEffect } from "react";
import { createVaultApi } from "@/src/core";
import { useVaultAvailable } from "./available.ts";

const api = createVaultApi({ base: "/api/vault" });

/**
 * Resumes the vault on launch: the server process opens it from secure storage and starts syncing
 * (POST /api/vault/session/open). Invisible; renders nothing, and does nothing unless the vault is
 * available. What the learner sees when this needs them (expired sign-in, locked keys) is the
 * Vault section of the settings dialog.
 */
export function VaultBoot() {
	const available = useVaultAvailable();
	useEffect(() => {
		if (available) void api.open().catch(() => {});
	}, [available]);
	return null;
}
