import { timingSafeEqual } from "node:crypto";

/** The cookie twin of the x-learnharness-desktop header (multi-device,
 * ADR 0001): an Android WebView cannot add a header to every fetch or
 * EventSource, so the Android shell sets the same per-launch secret as an
 * HttpOnly cookie on the loopback origin instead. */
export const DESKTOP_CAPABILITY_COOKIE = "lh_desktop";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return true;
	if (!expected || expected.length < 64) return false;
	const wanted = Buffer.from(expected);
	const matches = (supplied: string | null | undefined) => {
		if (!supplied) return false;
		const actual = Buffer.from(supplied);
		return actual.length === wanted.length && timingSafeEqual(actual, wanted);
	};
	return matches(headers.get("x-learnharness-desktop")) || matches(capabilityCookie(headers.get("cookie")));
}

function capabilityCookie(header: string | null): string | undefined {
	if (!header) return undefined;
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq !== -1 && pair.slice(0, eq).trim() === DESKTOP_CAPABILITY_COOKIE) return pair.slice(eq + 1).trim();
	}
	return undefined;
}
