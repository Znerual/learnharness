/**
 * DELETE /api/themes/[id] (theme wave, 2026-11-04) — remove an imported
 * theme. Presets cannot be removed (400); an unknown id is a 404. When
 * the removed theme was active, the record falls back to "default" and
 * every color override stays exactly as it was.
 */

import { isBuiltinThemeId } from "@/src/core";
import { readSettingsRecord, themeStore, writeSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	if (isBuiltinThemeId(id)) return Response.json({ error: `"${id}" is a built-in theme` }, { status: 400 });
	const theme = themeStore.readTheme(id);
	if (!theme) return Response.json({ error: `unknown theme "${id}"` }, { status: 404 });
	themeStore.deleteTheme(id);
	const record = readSettingsRecord();
	if (record?.appearance) {
		const appearance = { ...record.appearance };
		let changed = false;
		if (appearance.theme === id) { appearance.theme = "default"; changed = true; }
		// A System slot on the removed theme falls back to its factory theme.
		if (appearance.systemThemes && (appearance.systemThemes.light === id || appearance.systemThemes.dark === id)) {
			const pair = { ...appearance.systemThemes };
			if (pair.light === id) delete pair.light;
			if (pair.dark === id) delete pair.dark;
			appearance.systemThemes = pair;
			changed = true;
		}
		if (changed) writeSettingsRecord({ ...record, appearance });
	}
	return Response.json({ theme });
}
