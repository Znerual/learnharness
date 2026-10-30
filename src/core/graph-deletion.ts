/**
 * Session deletion — the FIRST destructive operation on the append-only
 * graph ledgers (owner ruling 2026-09-22, wave 6 chunk A).
 *
 * Until now mergeFindings has been the sole writer; deletion is the second,
 * and it is held to the same discipline: PURE code over the storage ports
 * (core/ports.ts), no LLM judgment anywhere, deterministic and idempotent.
 * The caller (the DELETE /api/chats/[id] route through the server
 * orchestration) owns the cross-store choreography (chat record, jobs,
 * extraction wind-down); this module owns the LEDGERS.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the stored truth is propositions +
 * reasoning chains; edges are a derived view. Deletion therefore operates
 * on CHAIN LINES where it used to operate on edge lines — a chain dies
 * when its provenance empties or any member node died — and the derived
 * view follows on the next read, never rewritten here.
 *
 * Two modes (owner-locked semantics):
 *
 *   preserve-graph  the ledgers keep everything: nodes and chains stay
 *                   byte-identical, and so does the extraction bookkeeping
 *                   (multi-device, owner, 2026-10-30: a session continued on another
 *                   device must not re-extract its old messages, so its
 *                   coverage and checkpoint rows stay in both modes).
 *                   The graph keeps the session's contributions; the
 *                   snapshot simply no longer resolves the dead chatId to
 *                   a title (nodeSessions filters unknown ids at read
 *                   time — no UI ghosting).
 *
 *   delete-nodes    "this session never happened": every trace of the
 *                   chat leaves the ledgers — its provenance points on
 *                   every node and chain line, its link lines (their
 *                   phrasings die with them) — and orphans die: a node
 *                   whose references all came from this chat disappears
 *                   entirely, pruned from the positions ledger too (dead
 *                   members would break cluster hulls).
 *
 * Shared nodes survive automatically (the ruling): a node lives iff ANY
 * surviving reference remains — a provenance point from another chat or
 * notes source. The create line of a surviving node is special:
 * name/statement/createdAt are the node's IDENTITY — the shared anchor
 * other sessions' link verdicts recognized — so they stay even when the
 * deleted chat created the node; but that session's phrasings (the line's
 * aliases) are stripped and its provenance points removed (owner ruling
 * 2026-09-23: all traces, identity survives).
 *
 * Not touched, by design:
 *   - imported-notes sources (src_…) — a different front door with its
 *     own lifecycle (re-import dedupes by path hash); this wave deletes
 *     CHATS.
 *
 * Resurrection safety: the deletion runs as ONE synchronous block (no
 * awaits — atomic vs the event loop, so no extraction append can
 * interleave), and the extraction pipeline re-checks the chat record
 * before each batch's merge (a deleted chat never merges). Both seams
 * together close every corrupt/resurrect path.
 *
 * MULTI-DEVICE (ADR 0003): devices only ever write their own ledger files,
 * so a deletion is not a rewrite. It is a RECORD (GraphDeletion) appended
 * to the deleting device's deletions file; the graph store replays every
 * device's records on each read through the same pure rules (purgeChat /
 * purgeNode below). A session deletion covers the lines written up to its
 * time, so a session that comes back from another device contributes again.
 */

import type {
	CoverageEntry,
	GraphChain,
	GraphDeletion,
	GraphNode,
	ProvenancePoint,
	SessionCheckpoint,
} from "./contracts.ts";
import type { GraphStore } from "./ports.ts";
import { chainKey } from "./graph.ts";

/** The two deletion modes (owner-locked 2026-09-22). Machine-checkable on
 *  the API as the required `mode` query param — no default, so no
 *  accidental destructive choice. */
export type ChatDeleteMode = "preserve-graph" | "delete-nodes";

/** What one deletion removed from the ledgers (the DELETE response's
 *  stats; the UI can show "3 topics, 2 links removed" from this). */
export interface ChatDeletionStats {
	/** Distinct nodes that died entirely (all their lines). */
	nodesRemoved: number;
	/** Chain assertion LINES removed (empty-provenance or dead member). */
	chainsRemoved: number;
}

const EMPTY_STATS: ChatDeletionStats = {
	nodesRemoved: 0,
	chainsRemoved: 0,
};

/** The four graph ledgers as one in-memory value — what a deletion
 *  transforms. */
export interface Ledgers {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
}

/** One deletion's effect on the ledgers. */
interface Purge {
	ledgers: Ledgers;
	/** Node ids that died entirely. */
	deadNodes: Set<string>;
	/** Chain ids whose every surviving line is gone. */
	deadChains: Set<string>;
}

/** Multi-device (ADR 0003): every ledger line carries the time it was
 *  written — a session deletion covers exactly the lines up to its `at`. */
const writtenBy = (at: string | undefined) => (time: string): boolean => at === undefined || time <= at;

/**
 * PURE: one chat's traces out of the ledgers (the rules in the header).
 * `at` limits the purge to lines written up to then (multi-device: a
 * deletion record replayed on read must leave a session's later
 * contributions alone); undefined = every line.
 */
export function purgeChat(ledgers: Ledgers, chatId: string, mode: ChatDeleteMode, at?: string): Purge & { stats: ChatDeletionStats } {
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		throw new Error(`Unknown deletion mode: ${mode as string}`);
	}
	const covered = writtenBy(at);
	// The extraction bookkeeping (coverage, checkpoints) stays in both
	// modes (owner, 2026-10-30): a session that comes back from another device must
	// not re-extract — and so resurrect — what this deletion removed.
	const stats: ChatDeletionStats = { ...EMPTY_STATS };
	const unchanged = ledgers;
	if (mode === "preserve-graph") return { ledgers: unchanged, stats, deadNodes: new Set(), deadChains: new Set() };

	// ── delete-nodes: the full purge ──────────────────────────────────────
	const nodeLines = ledgers.nodes;
	const chainLines = ledgers.chains;
	/** The chat's points on a line this deletion covers (a later line keeps them). */
	const strippable = (line: { createdAt: string; provenance: ProvenancePoint[] }) =>
		covered(line.createdAt) ? line.provenance.filter((pt) => pt.chatId === chatId).length : 0;

	// Does the chat touch the graph at all? (A never-extracted chat still
	// needs its coverage rows dropped above, nothing else.)
	if (!nodeLines.some((line) => strippable(line) > 0) && !chainLines.some((line) => strippable(line) > 0)) {
		return { ledgers: unchanged, stats, deadNodes: new Set(), deadChains: new Set() };
	}

	// 1. Survival: a node lives iff a reference from ANY surviving source
	//    remains — another chat/src's provenance point on any of its lines,
	//    or a point this deletion does not cover.
	//    (Chain members are deliberately NOT survival references: a
	//    chain's asserting session always left provenance on its endpoints,
	//    so endpoint-only liveness cannot occur in a consistent ledger —
	//    and counting it would keep nodes alive whose lines we would then
	//    drop, dangling the chain.)
	const survivingPoints = (line: { createdAt: string; provenance: ProvenancePoint[] }) =>
		covered(line.createdAt) ? line.provenance.filter((pt) => pt.chatId !== chatId) : line.provenance;
	const live = new Set<string>();
	for (const line of nodeLines) {
		if (survivingPoints(line).length > 0) live.add(line.id);
	}

	// 2. Node lines. Per-line (each line is ONE extraction run's append, so
	//    per-session alias provenance exists at line granularity):
	//      dead node            every line dies
	//      untouched line        kept verbatim
	//      partially-deleted     kept with the chat's points stripped
	//                           (defensive — single-run lines never mix chats)
	//      all points deleted    CREATE line: identity survives, aliases
	//                           stripped (owner ruling 2026-09-23), points
	//                           empty / LINK line: dies with its phrasings
	const outNodes: GraphNode[] = [];
	const seenIds = new Set<string>();
	for (const line of nodeLines) {
		if (!live.has(line.id)) continue; // the whole node dies
		const first = !seenIds.has(line.id);
		seenIds.add(line.id);
		const points = survivingPoints(line);
		if (points.length === line.provenance.length) {
			outNodes.push(line); // untouched by this chat
			continue;
		}
		if (points.length > 0) {
			outNodes.push({ ...line, provenance: points });
			continue;
		}
		if (first) {
			// The create line of a surviving node the deleted chat minted:
			// name/statement/createdAt are the shared identity other
			// sessions recognized — they stay; the session's phrasings and
			// provenance die (all traces, owner 2026-09-23).
			outNodes.push({ ...line, provenance: [], aliases: [] });
		}
		// else: the deleted chat's link line — dies with its phrasings.
	}

	// 3. Chains: strip the chat's points; an assertion dies when its
	//    provenance empties or ANY member node (premise or conclusion)
	//    died IN THIS DELETION. (Only nodes that existed and died count —
	//    a chain whose members never resolved as nodes is foreign data the
	//    deletion leaves alone: destructive rewriting may not exceed the
	//    deleted chat's blast radius.)
	const deadNodes = new Set([...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)));
	const outChains: GraphChain[] = [];
	for (const line of chainLines) {
		if (deadNodes.has(line.conclusion) || line.premises.some((premise) => deadNodes.has(premise))) continue;
		const points = survivingPoints(line);
		// An assertion dies when THIS deletion empties its provenance — a
		// line that already had no points is foreign/legacy data, not this
		// chat's trace; it rides untouched.
		if (line.provenance.length > 0 && points.length === 0) continue;
		outChains.push(points.length === line.provenance.length ? line : { ...line, provenance: points });
	}

	stats.nodesRemoved = deadNodes.size;
	stats.chainsRemoved = chainLines.length - outChains.length;
	const keptChainIds = new Set(outChains.map((line) => line.id));
	return {
		ledgers: { ...ledgers, nodes: outNodes, chains: outChains },
		stats,
		deadNodes,
		deadChains: new Set(chainLines.filter((line) => !keptChainIds.has(line.id)).map((line) => line.id)),
	};
}

/** PURE: full death of one node — or one argument, by its arg_ id (the
 *  rules below). An argument dies with every assertion of the same
 *  (premises, conclusion), whatever arg_ id another device minted for it
 *  (owner, 2026-10-30); `argument` names it when the id's own lines are gone.
 *  Null when no such node/chain exists. */
export function purgeNode(
	ledgers: Ledgers,
	nodeId: string,
	argument?: { premises: string[]; conclusion: string },
): (Purge & { stats: NodeDeletionStats }) | null {
	const chainLines = ledgers.chains;
	// The argument branch: an arg_ id names a CHAIN, not a proposition —
	// its lines die, and that is the whole death (the member propositions
	// survive: deleting an argument spares its premises/conclusion).
	if (nodeId.startsWith("arg_")) {
		const named = argument ?? chainLines.find((line) => line.id === nodeId);
		const key = named ? chainKey(named.premises, named.conclusion) : null;
		const outChains = chainLines.filter((line) => line.id !== nodeId && chainKey(line.premises, line.conclusion) !== key);
		if (outChains.length === chainLines.length) return null; // unknown argument
		return {
			ledgers: { ...ledgers, chains: outChains },
			stats: { chainsRemoved: chainLines.length - outChains.length },
			deadNodes: new Set(),
			deadChains: new Set(chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id)),
		};
	}
	if (!ledgers.nodes.some((line) => line.id === nodeId)) return null;
	const outChains = chainLines.filter((line) => line.conclusion !== nodeId && !line.premises.includes(nodeId));
	return {
		ledgers: { ...ledgers, nodes: ledgers.nodes.filter((line) => line.id !== nodeId), chains: outChains },
		stats: { chainsRemoved: chainLines.length - outChains.length },
		deadNodes: new Set([nodeId]),
		deadChains: new Set(chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id)),
	};
}

/** PURE: replay every device's deletion records, oldest first — what the
 *  graph store applies on every read (multi-device, ADR 0003). */
export function applyDeletions(ledgers: Ledgers, deletions: ReadonlyArray<GraphDeletion>): Ledgers {
	let out = ledgers;
	for (const record of [...deletions].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
		if (record.type === "session") out = purgeChat(out, record.chatId, record.mode, record.at).ledgers;
		else if (record.type === "chain") out = purgeNode(out, record.id, record)?.ledgers ?? out;
		else out = purgeNode(out, record.id)?.ledgers ?? out;
	}
	return out;
}

function readLedgers(graphStore: GraphStore): Ledgers {
	return {
		nodes: graphStore.readNodes(),
		chains: graphStore.readChains(),
		coverage: graphStore.readCoverage(),
		checkpoints: graphStore.readCheckpoints(),
	};
}

/** Positions die with the nodes and chains a deletion killed (an
 *  argument's derived implication node carries the chain's arg_ id —
 *  stale resting spots would pin nothing). The layout is device-local, so
 *  each device prunes its own; another device's stale spots pin nothing. */
function prunePositions(graphStore: GraphStore, purge: Purge): void {
	const positions = graphStore.readPositions();
	const pruned = Object.fromEntries(
		Object.entries(positions).filter(([id]) => !purge.deadNodes.has(id) && !purge.deadChains.has(id)),
	);
	if (Object.keys(pruned).length !== Object.keys(positions).length) graphStore.writePositions(pruned);
}

/**
 * Remove one chat's traces from the graph ledgers. Synchronous by design
 * (the atomicity argument above); idempotent (a second run finds nothing
 * and returns zero stats). Multi-device (ADR 0003): the removal is a
 * deletion RECORD appended to this device's own file, which every device
 * applies on read — no ledger file is ever rewritten.
 */
export function deleteChatTraces(graphStore: GraphStore, chatId: string, mode: ChatDeleteMode): ChatDeletionStats {
	const at = new Date().toISOString();
	const before = readLedgers(graphStore);
	const purge = purgeChat(before, chatId, mode, at);
	// Only a deletion that changes something leaves a record (a stripped
	// link line or provenance point counts, even when no stat moves).
	if (JSON.stringify(purge.ledgers) !== JSON.stringify(before)) {
		graphStore.appendDeletion({ type: "session", chatId, mode, at });
		prunePositions(graphStore, purge);
	}
	return purge.stats;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ───────────

/**
 * FULL DEATH for one node, by id (owner ruling 2026-09-23): the user
 * pointing at the node IS the intent — references from other sessions do
 * NOT preserve it. The remedy for undeletable nodes (preserve-graph
 * orphans from session deletion; notes-import nodes with no chat behind
 * them), and the deliberate inverse of the chat cascade above: that one
 * deletes a SESSION and lets nodes survive on foreign references; this
 * one deletes a NODE and takes its every trace —
 *
 *   - every line of the node (create + link lines)
 *   - every CHAIN referencing it (as premise or conclusion), whatever
 *     session asserted it — a chain with a dead member is not a chain
 *   - its resting position (and every dead chain's)
 *
 * An ARGUMENT deletion is the same call with an arg_-prefixed id (owner,
 * 2026-09-30: the chain table's fenced delete kills chains): the "node"
 * is the derived implication node whose id IS the chain's id.
 *
 * The blast radius is exactly the rows naming the id: other nodes'
 * provenance, aliases, and sessions are untouched (full death is
 * NODE-scoped, not session-scoped), and the source records of notes
 * imports stay (the import's bookkeeping; deleting one proposition is not
 * deleting the file). Derived data needs no pruning: the birth partition
 * derives on read (the cluster shrinks below MIN_CLUSTER_SIZE and stops
 * rendering — fine), and no other consumer indexes nodes by id across
 * ledgers.
 *
 * Synchronous, one deletion record, no awaits (the same atomicity
 * argument as the chat cascade); idempotent in the wave-6 sense — a
 * second run finds no lines and changes nothing. The death is permanent
 * (multi-device): a later link line from another device does not revive it.
 */
export interface NodeDeletionStats {
	/** Chain assertion LINES removed (every chain referencing the node). */
	chainsRemoved: number;
}

/**
 * Full-death one node (or one argument, by its arg_ id). Returns null
 * when no such node/chain exists (the orchestration maps that to 404).
 */
export function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null {
	const ledgers = readLedgers(graphStore);
	const purge = purgeNode(ledgers, nodeId);
	if (!purge) return null;
	const at = new Date().toISOString();
	const argument = ledgers.chains.find((line) => line.id === nodeId);
	graphStore.appendDeletion(
		argument
			? { type: "chain", id: nodeId, premises: argument.premises, conclusion: argument.conclusion, at }
			: { type: "node", id: nodeId, at },
	);
	prunePositions(graphStore, purge);
	return purge.stats;
}
