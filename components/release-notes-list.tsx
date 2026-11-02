"use client";

/**
 * What's new in an offered update (Vault builds): the vault host's
 * changelog entries after the installed version, as electron/changelog.cjs
 * picked them. Plain text only — a line starting with "- " or "* " is a
 * list item, other lines are paragraphs; nothing is read as HTML.
 */

export type UpdateNote = { version: string; released: string; notes: string };

/** Plain text to paragraphs and list items. Pure — exported for tests. */
export function noteLines(text: string): { kind: "p" | "li"; text: string }[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => (/^[-*] /.test(l) ? { kind: "li" as const, text: l.slice(2).trim() } : { kind: "p" as const, text: l }));
}

export function ReleaseNotesList({ notes, testid = "release-notes-list" }: { notes: UpdateNote[]; testid?: string }) {
	return (
		<div data-testid={testid} className="flex flex-col gap-3 text-sm">
			{notes.map((n) => (
				<section key={n.version}>
					<p className="font-medium">
						Version {n.version}
						{n.released && <span className="font-normal text-muted-foreground"> · {n.released}</span>}
					</p>
					{n.notes ? (
						<ul className="mt-1 list-disc space-y-1 pl-5">
							{noteLines(n.notes).map((l, i) =>
								l.kind === "li" ? <li key={i}>{l.text}</li> : <p key={i} className="-ml-5">{l.text}</p>,
							)}
						</ul>
					) : (
						<p className="text-muted-foreground">No notes were written for this version.</p>
					)}
				</section>
			))}
		</div>
	);
}
