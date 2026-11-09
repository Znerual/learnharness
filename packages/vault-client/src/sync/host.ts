// The host interface between the sync engine and LearnHarness (#31). The fork implements it
// over its file-system store adapters; FsHost is a plain data-folder implementation.

import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { writeFileAtomic } from "./fsutil.ts";

export interface AppliedChange {
	path: string;
	kind: "doc" | "seg";
	deleted: boolean;
}

export interface SyncHost {
	/** Current bytes of a document file, or null if it does not exist. */
	readDocument(path: string): Promise<Uint8Array | null>;
	/** Writes a document in remote mode (no outbox entry). */
	writeDocument(path: string, data: Uint8Array): Promise<void>;
	/** Deletes a document in remote mode. */
	deleteDocument(path: string): Promise<void>;
	/** Current size of a ledger file (0 if missing). */
	ledgerSize(file: string): Promise<number>;
	/** Bytes of a ledger file from offset to the end. */
	readLedger(file: string, offset: number): Promise<Uint8Array>;
	/** Writes bytes at an offset; idempotent for the same bytes. */
	writeLedger(file: string, offset: number, data: Uint8Array): Promise<void>;
	/** Stores a device-local conflict version; it never syncs. */
	writeConflict(path: string, data: Uint8Array): Promise<void>;
	/** Lists every syncable file, for seeding the vault from an existing data folder. */
	listFiles?(): Promise<string[]>;
	/** Called after a pull applied changes, so open views refresh (ADR 0007). */
	applied?(changes: AppliedChange[]): void;
}

function safeJoin(root: string, path: string): string {
	const p = join(root, path);
	const rel = relative(root, p);
	if (rel.startsWith("..") || rel.split(sep).includes("..")) throw new Error(`path escapes the data folder: ${path}`);
	return p;
}

/** A host over a plain LearnHarness data folder. */
export class FsHost implements SyncHost {
	readonly appliedLog: AppliedChange[][] = [];
	constructor(readonly root: string) {}

	async readDocument(path: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(safeJoin(this.root, path)));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}
	async writeDocument(path: string, data: Uint8Array): Promise<void> {
		await writeFileAtomic(safeJoin(this.root, path), data);
	}
	async deleteDocument(path: string): Promise<void> {
		await rm(safeJoin(this.root, path), { force: true });
	}
	async ledgerSize(file: string): Promise<number> {
		try {
			return (await stat(safeJoin(this.root, file))).size;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw e;
		}
	}
	async readLedger(file: string, offset: number): Promise<Uint8Array> {
		const size = await this.ledgerSize(file);
		if (size <= offset) return new Uint8Array(0);
		const fh = await open(safeJoin(this.root, file), "r");
		try {
			const buf = new Uint8Array(size - offset);
			await fh.read(buf, 0, buf.length, offset);
			return buf;
		} finally {
			await fh.close();
		}
	}
	async writeLedger(file: string, offset: number, data: Uint8Array): Promise<void> {
		const p = safeJoin(this.root, file);
		await mkdir(dirname(p), { recursive: true });
		const fh = await open(p, "a+").then(async (h) => {
			await h.close();
			return open(p, "r+");
		});
		try {
			await fh.write(data, 0, data.length, offset);
			await fh.sync();
		} finally {
			await fh.close();
		}
	}
	async writeConflict(path: string, data: Uint8Array): Promise<void> {
		const p = safeJoin(this.root, path);
		await mkdir(dirname(p), { recursive: true });
		await writeFile(p, data);
	}
	async listFiles(): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const p = join(dir, e.name);
				if (e.isDirectory()) await walk(p);
				else out.push(relative(this.root, p).split(sep).join("/"));
			}
		};
		await walk(this.root);
		return out.sort();
	}
	applied(changes: AppliedChange[]): void {
		this.appliedLog.push(changes);
	}
}
