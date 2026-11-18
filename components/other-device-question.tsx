"use client";
/**
 * The notice for a question this device did not ask (owner, 2026-11-18). Sessions sync between the
 * learner's devices, and submitting an answer to a graded question runs the question's checks on
 * this computer: the coding questions plugin starts the program the question names. A question
 * that came in from another device therefore waits until the learner allows its checks here
 * (POST /api/chats/[id]/allow-question; src/store/asked-questions.ts keeps the decision).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function OtherDeviceQuestionNotice({ chatId, id, details, onAllowed }: { chatId: string; id: string; details: unknown; onAllowed: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const allow = async () => {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/allow-question`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
			onAllowed();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Request failed");
		} finally {
			setBusy(false);
		}
	};
	let shown = "";
	try { shown = JSON.stringify(details, null, 2) ?? ""; } catch { shown = ""; }
	return <div role="alert" data-testid="other-device-question" className="mx-4 my-2 space-y-2 rounded-[8px] border border-border bg-muted/40 px-3 py-2 text-sm">
		<p className="font-medium">This question was not asked on this device.</p>
		<p className="text-muted-foreground">It came in by sync from another of your devices, or it is older than this version. Checking an answer runs the question&apos;s checks on this computer, and they can start programs. Allow them only if you recognise the question.</p>
		<details>
			<summary className="cursor-pointer text-muted-foreground">Show what the question contains</summary>
			<pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-xs">{shown}</pre>
		</details>
		{error && <p className="text-destructive">{error}</p>}
		<Button type="button" variant="outline" disabled={busy} onClick={() => { void allow(); }}>Allow checks on this device</Button>
	</div>;
}
