// Fake LearnHarness stores over a temp data folder, with the same file layout as the fork's
// file-system stores (chats/<id>.json, jobs/<id>.json, graph/<kind>.<device>.jsonl, ...).
// They check, at the moment of each write, that the intent was already recorded.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LearnHarnessStores } from "../src/server/vault/wire.ts";

/** Whether the vault client (packages/vault-client) loads; always true in a complete checkout. */
export const hasVaultClient = await import("@znerual/learnharness-vault-client").then(
	() => true,
	() => false,
);

/** `import(path)` when the vault client is installed, else an empty module (the tests using it are skipped). */
export async function loadIfVaultClient<T>(path: string): Promise<T> {
	return (hasVaultClient ? await import(path) : {}) as T;
}

export function tmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lhv-glue-${prefix}-`));
}

export class Recorder {
	/** True when the intents go elsewhere (the real engine), so the fake stores cannot check them. */
	permissive = false;
	readonly log: string[] = [];
	noteDocumentChangedSync(path: string): void {
		this.log.push(`doc ${path}`);
	}
	noteLedgerAppendedSync(file: string, offset: number): void {
		this.log.push(`led ${file}@${offset}`);
	}
	/** The recorded intents (not the writes). */
	get intents(): string[] {
		return this.log.filter((l) => !l.startsWith("write "));
	}
}

export const DEVICE = "dev_aaaaaaaa";

/** Stores that fail the test if they write without a fresh intent for exactly that file. */
export function fakeStores(dataDir: string, rec: Recorder, deviceId = DEVICE) {
	const wrote = (path: string, expect: "doc" | "led") => {
		if (rec.permissive) return;
		const last = rec.log.at(-1) ?? "";
		const ok = expect === "doc" ? last === `doc ${path}` : last.startsWith(`led ${path}@`);
		if (!ok) throw new Error(`write to ${path} without the intent right before it; log: ${rec.log.join(" | ")}`);
		rec.log.push(`write ${path}`);
	};
	const put = (path: string, text: string, expect: "doc" | "led" = "doc") => {
		wrote(path, expect);
		const p = join(dataDir, path);
		mkdirSync(dirname(p), { recursive: true });
		if (expect === "led") appendFileSync(p, text);
		else writeFileSync(p, text);
	};
	let n = 0;
	const stores = {
		chatStore: {
			createChat(title: string) {
				const id = `chat_${++n}`;
				rec.log.push(`write chats/${id}.json`); // the id is chosen inside: the note comes after
				mkdirSync(join(dataDir, "chats"), { recursive: true });
				writeFileSync(join(dataDir, "chats", `${id}.json`), JSON.stringify({ id, title }));
				return { id };
			},
			saveMessages(id: string, messages: unknown[]) {
				put(`chats/${id}.json`, JSON.stringify({ id, messages }));
			},
			saveImageSnapshot(id: string, snapshotId: string, _image: unknown) {
				put(`chats/${id}.json`, JSON.stringify({ id, snapshotId }));
			},
			updateSideChats(id: string, update: (threads: unknown[]) => unknown[]) {
				put(`chats/${id}.json`, JSON.stringify({ id, sideChats: update([]) }));
				return [] as unknown[];
			},
			saveTree(id: string, tree: unknown) {
				put(`chats/${id}.json`, JSON.stringify({ id, tree }));
			},
			appendTurnUsage(id: string, entry: unknown) {
				put(`chats/${id}.json`, JSON.stringify({ id, entry }));
			},
			appendExtractionUsage(id: string, entry: unknown) {
				put(`chats/${id}.json`, JSON.stringify({ id, entry }));
			},
			saveSettings(id: string, settings: unknown) {
				put(`chats/${id}.json`, JSON.stringify({ id, settings }));
			},
			setActiveTurn(id: string, a: unknown) {
				put(`chats/${id}.json`, JSON.stringify({ id, a }));
			},
			listConflicts: (_id: string) => [] as { file: string; updatedAt: string; messageCount: number }[],
			resolveConflict(id: string, keep: string) {
				if (keep !== "current") put(`chats/${id}.json`, "kept");
				return true;
			},
			renameChat(id: string, title: string) {
				put(`chats/${id}.json`, JSON.stringify({ id, title }));
				return { id, title };
			},
			deleteChat(id: string) {
				wrote(`chats/${id}.json`, "doc");
				rmSync(join(dataDir, "chats", `${id}.json`), { force: true });
				return true;
			},
		},
		jobStore: {
			createJob(_init: unknown) {
				const id = `job_${++n}`;
				rec.log.push(`write jobs/${id}.json`);
				mkdirSync(join(dataDir, "jobs"), { recursive: true });
				writeFileSync(join(dataDir, "jobs", `${id}.json`), JSON.stringify({ id, chatId: "chat_1" }));
				return { id, chatId: "chat_1" };
			},
			updateJob(id: string, patch: unknown) {
				put(`jobs/${id}.json`, JSON.stringify({ id, chatId: "chat_1", patch }));
				return null;
			},
			listJobs(chatId: string) {
				try {
					return readdirSync(join(dataDir, "jobs")).map((f) => JSON.parse(readFileSync(join(dataDir, "jobs", f), "utf8")) as { id: string; chatId: string }).filter((j) => j.chatId === chatId);
				} catch {
					return [];
				}
			},
			deleteJobsForChat(chatId: string) {
				const jobs = stores.jobStore.listJobs(chatId);
				for (const j of jobs) {
					wrote(`jobs/${j.id}.json`, "doc");
					rmSync(join(dataDir, "jobs", `${j.id}.json`));
				}
				return jobs.length;
			},
		},
		graphStore: {
			appendNode: (x: unknown) => put(`graph/nodes.${deviceId}.jsonl`, `${JSON.stringify(x)}\n`, "led"),
			appendChain: (x: unknown) => put(`graph/chains.${deviceId}.jsonl`, `${JSON.stringify(x)}\n`, "led"),
			appendCheckpoint: (x: unknown) => put(`graph/sessions.${deviceId}.jsonl`, `${JSON.stringify(x)}\n`, "led"),
			appendCoverage: (x: unknown) => put(`graph/coverage.${deviceId}.jsonl`, `${JSON.stringify(x)}\n`, "led"),
			appendDeletion: (x: unknown) => put(`graph/deletions.${deviceId}.jsonl`, `${JSON.stringify(x)}\n`, "led"),
			upsertSource: (x: unknown) => put("graph/sources.json", JSON.stringify(x)),
			deleteSources: (_ids: ReadonlySet<string>) => {
				put("graph/sources.json", "{}");
				return 1;
			},
			appendSourceUsage: (_id: string, x: unknown) => put("graph/sources.json", JSON.stringify(x)),
		},
		settingsStore: {
			writeSettings(s: unknown) {
				put("prompts/switches.json", JSON.stringify(s));
			},
		},
		sourceOrganizationStore: {
			write(s: unknown) {
				put("graph/source-organization.json", JSON.stringify(s));
			},
		},
		deviceStore: { getDevice: () => ({ id: deviceId, name: "Test" }) },
		promptOverrides: {
			writeOverride(p: string, text: string) {
				put(`prompts/${p}`, text);
			},
			deleteOverride(p: string) {
				wrote(`prompts/${p}`, "doc");
				rmSync(join(dataDir, "prompts", p), { force: true });
			},
		},
	};
	// The fakes implement only the methods the vault wraps; the tests use them as the real ports.
	return stores as unknown as { [K in keyof LearnHarnessStores | "promptOverrides"]: any };
}

export function read(root: string, path: string): string | null {
	const p = join(root, path);
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}
