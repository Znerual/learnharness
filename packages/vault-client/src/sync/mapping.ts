// Record mapping of ADR 0007: LearnHarness files <-> record paths.

const LEDGER_FILE_RE = /^graph\/([a-z][a-z0-9_-]{0,31})\.(dev_[a-z0-9]{8})\.jsonl$/;
const BASE_LEDGER_FILE_RE = /^graph\/([a-z][a-z0-9_-]{0,31})\.jsonl$/;
const DEAD_BASE_LEDGERS = new Set(["edges", "events"]);
const SEGMENT_PATH_RE = /^ledger\/([a-z][a-z0-9_-]{0,31})\/(dev_[a-z0-9]{8}|base)\/([0-9]{12})$/;

export interface LedgerFileInfo {
	ledger: string;
	/** The owning device id, or "base" for a pre-split shared ledger. */
	owner: string;
}

/** Parses a ledger file path, or returns null if the file is not a ledger. */
export function parseLedgerFile(file: string): LedgerFileInfo | null {
	const m = LEDGER_FILE_RE.exec(file);
	if (m) return { ledger: m[1] as string, owner: m[2] as string };
	const b = BASE_LEDGER_FILE_RE.exec(file);
	// edges.jsonl and events.jsonl are dead pre-chains ledgers that LearnHarness deletes at start.
	if (b && !DEAD_BASE_LEDGERS.has(b[1] as string)) return { ledger: b[1] as string, owner: "base" };
	return null;
}

export function ledgerFileFor(ledger: string, owner: string): string {
	return owner === "base" ? `graph/${ledger}.jsonl` : `graph/${ledger}.${owner}.jsonl`;
}

export function segmentPath(file: string, offset: number): string {
	const info = parseLedgerFile(file);
	if (!info) throw new Error(`not a ledger file: ${file}`);
	return `ledger/${info.ledger}/${info.owner}/${String(offset).padStart(12, "0")}`;
}

export function parseSegmentPath(path: string): { file: string; ledger: string; owner: string; offset: number } | null {
	const m = SEGMENT_PATH_RE.exec(path);
	if (!m) return null;
	const ledger = m[1] as string;
	const owner = m[2] as string;
	return { file: ledgerFileFor(ledger, owner), ledger, owner, offset: Number(m[3]) };
}

/** Prompt override files mirror the source layout (system-prompt.md, teacher/<file>.md, ...) plus switches.json. */
const PROMPT_FILE_RE = /^prompts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:md|json)$/;

/** Document files that sync (ADR 0007 table). Device-local files under local/ never sync. */
export function isDocumentPath(path: string): boolean {
	if (path.startsWith("local/") || path.includes(".sync-conflict-")) return false;
	return /^chats\/[^/]+\.json$/.test(path) || /^jobs\/[^/]+\.json$/.test(path) || path === "graph/sources.json" || path === "graph/format.json" || PROMPT_FILE_RE.test(path);
}

function stamp(d: Date): { date: string; time: string } {
	const p = (n: number) => String(n).padStart(2, "0");
	return { date: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` };
}

/**
 * The device part of a session conflict name. LearnHarness's conflict picker (conflictPattern in
 * src/store/chats.ts) accepts only [A-Za-z0-9-] there, so the underscore of `dev_xxxxxxxx` is dropped.
 */
export function conflictDeviceTag(deviceId: string): string {
	return deviceId.replace(/[^A-Za-z0-9-]/g, "");
}

/**
 * Where the losing local version of a document goes (ADR 0008): sessions keep the name the
 * existing conflict picker reads; other documents go to local/conflicts/.
 */
export function conflictPath(path: string, deviceId: string, now: Date): string {
	const s = stamp(now);
	const chat = /^chats\/(.+)\.json$/.exec(path);
	if (chat) return `chats/${chat[1]}.sync-conflict-${s.date}-${s.time}-${conflictDeviceTag(deviceId)}.json`;
	return `local/conflicts/${path}.${s.date}-${s.time}`;
}
