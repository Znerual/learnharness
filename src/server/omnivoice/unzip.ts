/**
 * Picks named files out of a zip (owner, 2026-11-09): the built-in voice
 * engine takes NVIDIA's CUDA libraries from their Python wheels, which are zip
 * files, and GNU tar on Linux cannot read zip. Only what a wheel needs: stored
 * or deflated entries, no zip64, no encryption. Entries stream to disk, so a
 * 750 MB library never sits in memory. The wheel itself was checked against
 * its pinned SHA-256 before this runs.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

interface Entry {
	name: string;
	method: number;
	compressed: number;
	size: number;
	localHeader: number;
}

async function readAt(file: import("node:fs/promises").FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await file.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

async function centralDirectory(file: import("node:fs/promises").FileHandle, fileSize: number): Promise<Entry[]> {
	// The end-of-central-directory record sits in the last 22 bytes plus at most a 64 KB comment.
	const tailLength = Math.min(fileSize, 22 + 0xffff);
	const tail = await readAt(file, fileSize - tailLength, tailLength);
	const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (end < 0) throw new Error("Not a zip file");
	const count = tail.readUInt16LE(end + 10);
	const size = tail.readUInt32LE(end + 12);
	const offset = tail.readUInt32LE(end + 16);
	if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("zip64 is not supported");
	const directory = await readAt(file, offset, size);
	const entries: Entry[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error("Broken zip central directory");
		const flags = directory.readUInt16LE(at + 8);
		const method = directory.readUInt16LE(at + 10);
		const compressed = directory.readUInt32LE(at + 20);
		const uncompressed = directory.readUInt32LE(at + 24);
		const nameLength = directory.readUInt16LE(at + 28);
		const extraLength = directory.readUInt16LE(at + 30);
		const commentLength = directory.readUInt16LE(at + 32);
		const localHeader = directory.readUInt32LE(at + 42);
		const name = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		if (!(flags & 1)) entries.push({ name, method, compressed, size: uncompressed, localHeader });
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** Extract the entries whose file name (without folders) is in `names` into `into`, flat. Throws when one is missing. */
export async function unzipPicked(archive: string, into: string, names: readonly string[]): Promise<void> {
	const file = await open(archive, "r");
	let picked: Entry[];
	try {
		const { size } = await file.stat();
		picked = (await centralDirectory(file, size)).filter((e) => names.includes(path.posix.basename(e.name)));
		const missing = names.filter((n) => !picked.some((e) => path.posix.basename(e.name) === n));
		if (missing.length) throw new Error(`${path.basename(archive)} lacks ${missing.join(", ")}`);
		for (const entry of picked) {
			if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported zip compression (${entry.method})`);
			const local = await readAt(file, entry.localHeader, 30);
			if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("Broken zip entry");
			const start = entry.localHeader + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
			const target = path.join(into, path.posix.basename(entry.name));
			const source = createReadStream(archive, { start, end: start + entry.compressed - 1 });
			if (entry.method === 8) await pipeline(source, createInflateRaw(), createWriteStream(target));
			else await pipeline(source, createWriteStream(target));
			if ((await stat(target)).size !== entry.size) throw new Error(`${entry.name} unpacked to the wrong size`);
		}
	} finally {
		await file.close();
	}
}
