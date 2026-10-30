import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured } from "@/src/core";
import { compactionInFlight, foreignOwner, getChat, isTurnRunning, readSettingsRecord, stores, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) {
		// Saved by a NEWER app (multi-device: devices update at different
		// times) — say so instead of a 404.
		const newer = stores.chatStore.newerChat(id);
		if (!newer) notFound();
		return (
			<div className="flex h-full items-center justify-center px-4" data-testid="newer-session">
				<div className="max-w-sm text-center font-ui text-sm text-muted-foreground">
					<p className="mb-2 text-lg font-medium text-foreground">{newer.title}</p>
					<p>This session was saved by a newer LearnHarness. Update this app to open it.</p>
				</div>
			</div>
		);
	}
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				initialMessages={chat.messages}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
			// Multi-device: another device runs this session — read-only here.
			initialOwnedElsewhere={foreignOwner(chat.id)}
			// Multi-device: versions a sync tool kept beside this session.
			initialConflicts={stores.chatStore.listConflicts(chat.id)}
			initialUpdatedAt={chat.updatedAt}
		/>
	);
}
