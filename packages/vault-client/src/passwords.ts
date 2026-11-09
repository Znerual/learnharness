// Password rules (ADR 0004): at least 12 characters and not in a breached-password list.
//
// Choice (#28): a k-anonymity range query against the Have I Been Pwned "Pwned Passwords" API
// (only the first 5 hex characters of the SHA-1 leave the device, with response padding), plus a
// small bundled list of the most common passwords that works offline. If the range query fails
// (offline), the bundled list alone decides and the result says the online check was skipped.

import { createHash } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 12;

const COMMON = new Set([
	"123456789012", "password1234", "qwertyuiopas", "111111111111", "000000000000", "123123123123", "iloveyou1234", "passwordpassword",
	"qwerty123456", "letmeinplease", "administrator", "123456123456", "abcdefghijkl", "welcome12345", "correcthorsebatterystaple",
	"monkeymonkey", "dragondragon", "football1234", "baseball1234", "sunshine1234", "princess1234", "trustno1trustno1",
]);

export type PasswordCheck =
	| { ok: true; onlineChecked: boolean }
	| { ok: false; reason: "too_short" | "common" | "breached"; breachCount?: number };

export interface PasswordCheckOptions {
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Skip the online range query (tests, offline mode). */
	offline?: boolean;
}

export async function checkPassword(password: string, o: PasswordCheckOptions = {}): Promise<PasswordCheck> {
	if ([...password].length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
	const normalized = password.toLowerCase().replace(/\s+/g, "");
	if (COMMON.has(normalized)) return { ok: false, reason: "common" };
	if (o.offline) return { ok: true, onlineChecked: false };
	const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
	const prefix = sha1.slice(0, 5);
	const suffix = sha1.slice(5);
	try {
		const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
		const res = await f(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(5000) });
		if (!res.ok) return { ok: true, onlineChecked: false };
		for (const line of (await res.text()).split("\n")) {
			const [s, n] = line.trim().split(":");
			if (s === suffix && Number(n) > 0) return { ok: false, reason: "breached", breachCount: Number(n) };
		}
		return { ok: true, onlineChecked: true };
	} catch {
		return { ok: true, onlineChecked: false };
	}
}
