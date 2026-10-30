/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers at
 * config.LEDGER_FILES (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *   coverage.jsonl  CoverageEntry    — per-message extraction coverage
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. A stale edges.jsonl left by a pre-chains
 * build is deleted once, here, at adapter load (same doctrine as the
 * events-ledger purge below).
 *
 * Plus config.SOURCES_FILE (sources.json): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * MULTI-DEVICE (ADR 0003): every ledger exists once per device —
 * nodes.<deviceId>.jsonl, chains.<deviceId>.jsonl, … — and a device only
 * ever appends to its OWN files, so files that sync between devices never
 * conflict. The pre-split files at config.LEDGER_FILES stay as a read-only
 * shared base. Reads return the EFFECTIVE lines: the legacy base, then
 * every device's file (by name), each node's defining line first (link
 * lines carry `link: true`), with every device's deletion records
 * (deletions.<deviceId>.jsonl) applied and redundant chains simplified
 * away — so every consumer sees the same graph on every device.
 *
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES, PATHS, POSITIONS_FILE, SOURCES_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { applyDeletions } from "../core/graph-deletion.ts";
import { simplifyChains } from "../core/graph.ts";
import { deviceStore } from "./device.ts";
import type {
	GraphChain,
	GraphDeletion,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

// ─── JSONL primitives ────────────────────────────────────────────────────────

function appendLine<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return []; // no ledger yet — nothing has ever been emitted
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// Corrupt line: skip rather than fail the whole read — a torn
			// append must never take the home graph down with it.
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";


/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

const isDeletion = (v: unknown): v is GraphDeletion =>
	isRecord(v) &&
	isString(v.at) &&
	((v.type === "session" && isString(v.chatId) && (v.mode === "preserve-graph" || v.mode === "delete-nodes")) ||
		((v.type === "node" || v.type === "chain") && isString(v.id)));

// ─── per-device ledger files ────────────────────────────────────────────────

type LedgerKind = "nodes" | "chains" | "sessions" | "coverage" | "deletions";

/** A device's own file for one ledger (multi-device, ADR 0003). */
function deviceFile(kind: LedgerKind, deviceId: string): string {
	return path.join(PATHS.graph, `${kind}.${deviceId}.jsonl`);
}

/** Every device's file for one ledger, by name — sync-tool leftovers
 *  (temp files, conflict copies) never match. */
function deviceFiles(kind: LedgerKind): string[] {
	const pattern = new RegExp(`^${kind}\\.dev_[a-z0-9]{8}\\.jsonl$`);
	try {
		return fs
			.readdirSync(PATHS.graph)
			.filter((name) => pattern.test(name))
			.sort()
			.map((name) => path.join(PATHS.graph, name));
	} catch {
		return []; // no graph dir yet
	}
}

/** Every ledger file this build reads — the graph revision's inputs. */
export function ledgerFiles(): string[] {
	const kinds: LedgerKind[] = ["nodes", "chains", "sessions", "coverage", "deletions"];
	return [...Object.values(LEDGER_FILES), ...kinds.flatMap(deviceFiles)];
}

/** One ledger across the legacy base and every device, in read order. */
function readAll<T>(legacy: string | null, kind: LedgerKind, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	const files = [...(legacy ? [legacy] : []), ...deviceFiles(kind)];
	return files.flatMap((file) => readRawLines(file).filter(isValid));
}

/**
 * Node lines in DEFINING order: each node's create line before its link
 * lines, whichever file holds which (the legacy base keeps file order: its
 * first line per id defines). A link line whose node has no create line
 * left is dropped. The marker is stripped — consumers see plain GraphNodes.
 */
function orderNodeLines(legacy: GraphNode[], devices: GraphNode[]): GraphNode[] {
	const defined = new Set<string>();
	for (const line of legacy) defined.add(line.id);
	for (const line of devices) if (!line.link) defined.add(line.id);
	const out: GraphNode[] = [];
	const emitted = new Set<string>();
	const waiting = new Map<string, GraphNode[]>();
	const emit = (line: GraphNode) => {
		const { link: _marker, ...plain } = line;
		out.push(plain);
	};
	for (const line of legacy) {
		emit(line);
		emitted.add(line.id);
	}
	for (const line of devices) {
		if (!line.link) {
			if (emitted.has(line.id)) continue; // a second create line for one id: the first stands
			emit(line);
			emitted.add(line.id);
			for (const held of waiting.get(line.id) ?? []) emit(held);
			waiting.delete(line.id);
		} else if (emitted.has(line.id)) emit(line);
		else if (defined.has(line.id)) waiting.set(line.id, [...(waiting.get(line.id) ?? []), line]);
		// else: an orphaned link line (its node is gone) — dropped
	}
	return out;
}

// ─── the port implementation ────────────────────────────────────────────────

/**
 * The fs GraphStore for one device. `deviceId` is read per write, so the
 * production store follows local/device.json; tests make two devices share
 * one data folder.
 */
export function createGraphStore(deviceId: () => string): GraphStore {
	const append = (kind: LedgerKind, record: unknown) => appendLine(deviceFile(kind, deviceId()), record);

	/** The four ledgers with every device's deletion records applied. */
	const effective = () => {
		assertGraphFormat(); // honest refusal on a newer-stamped data dir
		const nodes = orderNodeLines(
			readRawLines(LEDGER_FILES.nodes).filter(isGraphNode),
			deviceFiles("nodes").flatMap((file) => readRawLines(file).filter(isGraphNode)),
		);
		return applyDeletions(
			{
				nodes,
				chains: readAll(LEDGER_FILES.chains, "chains", isGraphChain),
				coverage: readAll(LEDGER_FILES.coverage, "coverage", isCoverageEntry),
				checkpoints: readAll(LEDGER_FILES.sessions, "sessions", isCheckpoint),
			},
			readAll(null, "deletions", isDeletion),
		);
	};

	return {
		/** Appends to THIS device's ledger. A line re-encountering an existing
		 *  node must carry `link: true` (the merger sets it). */
		appendNode(node: GraphNode): void {
			append("nodes", node);
		},
		/** Effective node lines, defining line first per id. A node id may
		 *  appear on more than one line (a later session's LINK-append:
		 *  phrasings + provenance); the derivation (core/graph.ts getGraph)
		 *  merges lines by id. */
		readNodes(): GraphNode[] {
			return effective().nodes;
		},

		/** Append one chain ASSERTION; readers merge lines by (premises,
		 *  conclusion). */
		appendChain(assertion: GraphChain): void {
			append("chains", assertion);
		},
		/** Effective chain lines, redundant derivations simplified away on
		 *  read (core/graph.ts simplifyChains) — they stay on disk. */
		readChains(): GraphChain[] {
			return simplifyChains(effective().chains);
		},

		appendCheckpoint(checkpoint: SessionCheckpoint): void {
			append("sessions", checkpoint);
		},
		readCheckpoints(): SessionCheckpoint[] {
			return effective().checkpoints;
		},

		appendCoverage(entry: CoverageEntry): void {
			append("coverage", entry);
		},
		readCoverage(): CoverageEntry[] {
			return effective().coverage;
		},

		appendDeletion(record: GraphDeletion): void {
			append("deletions", record);
		},
		readDeletions(): GraphDeletion[] {
			return readAll(null, "deletions", isDeletion);
		},

		// ── imported-notes bookkeeping (config.SOURCES_FILE — a JSON map) ──

		/** Upsert: keeps the existing record's usage log when re-importing. */
		upsertSource(source: NotesSource): void {
			const all = readSourceMap();
			const prev = all[source.id];
			all[source.id] = prev ? { ...source, extractions: prev.extractions } : source;
			writeSourceMap(all);
		},
		readSources(): NotesSource[] {
			return Object.values(readSourceMap());
		},
		/** Idempotent per startedAt — same discipline as chats.appendExtractionUsage. */
		appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
			const all = readSourceMap();
			const source = all[id];
			if (!source) return; // no such source — nothing to bill against
			source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
				? source.extractions
				: [...(source.extractions ?? []), entry];
			writeSourceMap(all);
		},

		// ── the layout ledger (config.POSITIONS_FILE — device-local JSON map) ──
		readPositions(): Record<string, Position> {
			return readPositionMap();
		},
		writePositions(positions: Record<string, Position>): void {
			writePositionMap(positions);
		},
	};
}

/** The production store: this device's identity from local/device.json. */
export const graphStore: GraphStore = createGraphStore(() => deviceStore.getDevice().id);

/** positions.json — { positions, updatedAt }. Read-modify-write, NOT
 *  append-only: the settle is a full-graph computation, so it replaces the
 *  whole map. The updatedAt stamp exists for future live-physics conflict
 *  handling (a browser commit must be able to detect "the graph changed
 *  underneath me"); reads just return the map. */
function readPositionMap(): Record<string, Position> {
	let raw: string;
	try {
		raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
	} catch {
		return {}; // no ledger yet — nothing has ever settled
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(parsed.positions)) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	} catch {
		return {};
	}
}

function writePositionMap(positions: Record<string, Position>): void {
	fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
	// Tmp + rename — the same crash-safety rewriteLedgers uses two blocks
	// up (a9339b3 UI flag): a torn write must never replace the ledger
	// with a half-written file the reader parses as empty.
	const tmp = `${POSITIONS_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"), "utf-8");
		fs.renameSync(tmp, POSITIONS_FILE);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/** sources.json — { id: NotesSource }. Read-modify-write, NOT append-only:
 *  the usage log lives inside the record (like a chat's JSON file). */
function readSourceMap(): Record<string, NotesSource> {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(SOURCES_FILE, "utf-8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const out: Record<string, NotesSource> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (isNotesSource(value)) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function writeSourceMap(map: Record<string, NotesSource>): void {
	fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	fs.writeFileSync(SOURCES_FILE, JSON.stringify(map, null, "\t"), "utf-8");
}

// ─── one-way purges at adapter load: dead ledgers are exactly the confusion
// the cleanup removes (owner doctrine — nothing reads them, nothing writes
// them, a stale file lying around is a lie). ────────────────────────────────
{
	const graphDir = path.dirname(LEDGER_FILES.nodes);
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);
