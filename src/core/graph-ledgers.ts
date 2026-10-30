/**
 * THE EFFECTIVE GRAPH LEDGERS (multi-device, ADR 0003): the store keeps one
 * raw ledger file per device beside the legacy shared base and never
 * decides; this module derives what every GraphStore reader sees —
 *
 *   1. node lines in DEFINING order: each node's create line before its
 *      link lines, whichever file holds which (the legacy base keeps file
 *      order; in device files the unmarked line defines, link lines carry
 *      `link: true`). A link line whose node has no create line left is
 *      dropped, and the marker is stripped;
 *   2. every device's deletion records replayed, oldest first, through the
 *      pure deletion rules (core/graph-deletion.ts applyDeletions);
 *   3. redundant chains simplified away (core/graph.ts simplifyChains) —
 *      they stay on disk, no device rewrites a ledger.
 *
 * Wired once in the composition root (src/server/stores.ts). The derived
 * view is cached per ledger revision, so repeated reads within one merge or
 * deletion do not re-read and replay every file.
 */

import type { GraphNode } from "./contracts.ts";
import type { GraphLedgerStore, GraphStore } from "./ports.ts";
import { applyDeletions, type Ledgers } from "./graph-deletion.ts";
import { simplifyChains } from "./graph.ts";

/** Node lines in defining order (rule 1 above). */
export function orderNodeLines(legacy: GraphNode[], devices: GraphNode[]): GraphNode[] {
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

/** The GraphStore every consumer reads: the raw ledgers' effective view. */
export function effectiveGraphStore(raw: GraphLedgerStore): GraphStore {
	let cached: { revision: string; ledgers: Ledgers } | null = null;
	const view = (): Ledgers => {
		const revision = raw.revision();
		if (cached?.revision !== revision) {
			const lines = raw.readLines();
			const ledgers = applyDeletions(
				{ nodes: orderNodeLines(lines.nodes.legacy, lines.nodes.devices), chains: lines.chains, coverage: lines.coverage, checkpoints: lines.checkpoints },
				lines.deletions,
			);
			cached = { revision, ledgers: { ...ledgers, chains: simplifyChains(ledgers.chains) } };
		}
		// Copies: a caller mutating what it read must never corrupt the cache.
		return structuredClone(cached.ledgers);
	};
	return {
		...raw,
		readNodes: () => view().nodes,
		readChains: () => view().chains,
		readCheckpoints: () => view().checkpoints,
		readCoverage: () => view().coverage,
		readDeletions: () => raw.readLines().deletions,
	};
}
