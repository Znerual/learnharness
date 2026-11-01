// Shared by the migration tests: copies of the fixture folders under tests/fixtures/migration/
// (written by that folder's generate.ts with the store code of each release).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FIXTURES = path.join(import.meta.dirname, "..", "fixtures", "migration");

/** The releases a fixture exists for, with what each one is. */
export const SOURCES = [
	{ name: "v0.3.0", who: "upstream, the oldest supported release", older: true, deadFiles: true, needed: true },
	{ name: "v0.3.6001", who: "fork before the multi-device split", older: true, deadFiles: false, needed: true },
	{ name: "v0.4.1", who: "upstream, the newest release", older: true, deadFiles: false, needed: true },
	{ name: "v0.3.8001", who: "fork with the device-local split", older: false, deadFiles: false, needed: false },
	{ name: "v0.4.2001", who: "fork, the newest release", older: false, deadFiles: false, needed: true },
] as const;

export interface Folders {
	root: string;
	dataDir: string;
	localDir: string;
}

/** A fresh copy of a fixture in a temp folder. The local folder always exists, as it does in the apps. */
export function copyFixture(name: string): Folders {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `lh-mig-${name}-`));
	const dataDir = path.join(root, "data");
	const localDir = path.join(root, "local");
	fs.cpSync(path.join(FIXTURES, name, "lh-data"), dataDir, { recursive: true });
	const local = path.join(FIXTURES, name, "lh-local");
	if (fs.existsSync(local)) fs.cpSync(local, localDir, { recursive: true });
	else fs.mkdirSync(localDir, { recursive: true });
	return { root, dataDir, localDir };
}

export function files(dir: string): string[] {
	const out: string[] = [];
	const visit = (d: string, rel: string) => {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) visit(path.join(d, e.name), r);
			else out.push(r);
		}
	};
	visit(dir, "");
	return out;
}

/** path -> sha256 of every file under dir. */
export function digest(dir: string): Record<string, string> {
	return Object.fromEntries(files(dir).map((f) => [f, createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")]));
}

export const read = (...p: string[]): string => fs.readFileSync(path.join(...p), "utf-8");
export const json = (...p: string[]): any => JSON.parse(read(...p));
export const DEVICE = { id: "dev_fixture1", name: "Fixture desktop" };
