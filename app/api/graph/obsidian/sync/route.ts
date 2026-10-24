/**
 * /api/graph/obsidian/sync — the vault → graph Sync (obsidian wave,
 * owner 2026-10-24).
 *
 * POST starts a Sync in the background: every new or changed vault note
 * runs through the notes front door (src/server/obsidian.ts). 202
 * {status}; 409 when one is already running; 400 when no vault is
 * configured. Progress shows in the status chips like any notes import,
 * and GET returns the Sync's own counters.
 */
import { extraction, obsidianVault, startVaultSync, vaultSyncStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ status: vaultSyncStatus(), vault: obsidianVault() });
}

export async function POST() {
	const vault = obsidianVault();
	if (!vault) {
		return Response.json({ error: "No Obsidian vault configured — set one in Settings → Graph" }, { status: 400 });
	}
	const started = startVaultSync(vault, (input) => extraction.importNotes(input));
	if (!started) return Response.json({ error: "A vault sync is already running", status: vaultSyncStatus() }, { status: 409 });
	return Response.json({ status: started.status }, { status: 202 });
}
