/**
 * Two file moves the multi-device stores share: an atomic replace (a
 * synced or device-local record must never be read half-written) and a
 * move that also works across filesystems (Android keeps the synced data
 * folder in shared storage and device-local records in app-private storage).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Write beside the target, then rename over it (POSIX-atomic). */
export function writeFileAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, text, "utf-8");
		fs.renameSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

/** Move a file or folder; copy-then-remove when the two sit on different filesystems. */
export function moveFile(from: string, to: string): void {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	try {
		fs.renameSync(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
		fs.cpSync(from, to, { recursive: true });
		fs.rmSync(from, { recursive: true, force: true });
	}
}
