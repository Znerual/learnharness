// Crash-safe file helpers: append with fsync, atomic replace (ADR 0007 consequences).

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendSync(path: string, data: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const fh = await open(path, "a");
	try {
		await fh.write(data);
		await fh.sync();
	} finally {
		await fh.close();
	}
}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const fh = await open(tmp, "w");
	try {
		await fh.writeFile(data);
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, path);
	const d = await open(dir, "r");
	try {
		await d.sync();
	} catch {
		// directory fsync is not supported on every platform (Windows)
	} finally {
		await d.close();
	}
}

/** Synchronous `appendSync`, for hosts whose store ports are synchronous (the intent must be durable before the write). */
export function appendFsyncSync(path: string, data: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a");
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Synchronous `writeFileAtomic`. */
export function writeFileAtomicSync(path: string, data: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	try {
		const d = openSync(dir, "r");
		try {
			fsyncSync(d);
		} finally {
			closeSync(d);
		}
	} catch {
		// directory fsync is not supported on every platform (Windows)
	}
}
