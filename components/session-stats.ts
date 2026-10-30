"use client";

import { useSyncExternalStore } from "react";
import type { SessionPricing, TurnUsage } from "@/src/core";

/**
 * The open session's stats for Settings → This session (Android app,
 * owner, 2026-10-30): the in-session stats bar publishes what it knows,
 * the settings section reads it. Null outside a session.
 */

/** What the in-session bar knows, for Settings → This session. */
export interface SessionStats {
	chatId: string;
	turns: TurnUsage[];
	contextTokens: number | null;
	pricing?: SessionPricing;
	selectedModel?: string;
}

let sessionStats: SessionStats | null = null;
const statsListeners = new Set<() => void>();
export function publishSessionStats(next: SessionStats | null): void {
	sessionStats = next;
	for (const listener of statsListeners) listener();
}

/** The open session's stats right now (non-reactive). */
export function sessionStatsNow(): SessionStats | null {
	return sessionStats;
}

/** The open session's stats, or null outside a session. */
export function useSessionStats(): SessionStats | null {
	return useSyncExternalStore(
		(listener) => {
			statsListeners.add(listener);
			return () => statsListeners.delete(listener);
		},
		() => sessionStats,
		() => null,
	);
}

