// The documents the version history can restore one by one (Settings, Vault, History): every synced
// file in the data folder except the knowledge-graph ledgers (graph/*.jsonl), whose segments are
// restored with the whole vault. Chats and background jobs get a readable title, so nobody has to
// know a file path. Documents that exist only in history (deleted here) are not listed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HistoryDocumentDto } from "../../core/vault/contract.ts";

function readJson(file: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function walk(root: string, dir = ""): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const rel = dir ? `${dir}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walk(root, rel));
		else if (e.isFile()) out.push(rel);
	}
	return out;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Newest first. */
export function listHistoryDocuments(dataDir: string): HistoryDocumentDto[] {
	const files = walk(dataDir).filter((p) => !/^graph\/.*\.jsonl$/.test(p) && !/\.tmp-/.test(p));
	const chatTitles = new Map<string, string>();
	const docs: HistoryDocumentDto[] = [];
	for (const path of files) {
		const abs = join(dataDir, path);
		const json = path.endsWith(".json") ? readJson(abs) : null;
		let mtime: string | null = null;
		try {
			mtime = statSync(abs).mtime.toISOString();
		} catch {
			// gone since the listing
		}
		const updatedAt = text(json?.["updatedAt"]) ?? mtime;
		if (path.startsWith("chats/")) {
			const title = text(json?.["title"]) ?? "Untitled chat";
			const id = text(json?.["id"]);
			if (id) chatTitles.set(id, title);
			docs.push({ path, kind: "chat", title, updatedAt });
		} else if (path.startsWith("jobs/")) {
			docs.push({ path, kind: "job", title: text(json?.["kind"]) ?? "Background job", updatedAt, chatId: text(json?.["chatId"]) ?? undefined });
		} else {
			docs.push({ path, kind: "other", title: path, updatedAt });
		}
	}
	// a job is named after its chat: "research for <chat title>"
	for (const d of docs) {
		if (d.kind !== "job") continue;
		const chat = d.chatId ? chatTitles.get(d.chatId) : undefined;
		d.title = chat ? `${d.title} for "${chat}"` : d.title;
		delete d.chatId;
	}
	return docs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
