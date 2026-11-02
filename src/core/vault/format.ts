// Small pure formatting helpers shared by view models and components.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function unit(n: number, name: string): string {
	return `${n} ${name}${n === 1 ? "" : "s"}`;
}

/** "5 minutes ago", "in 3 hours", "just now". Accepts an ISO string. */
export function relativeTime(iso: string, now: Date): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "at an unknown time";
	const diff = now.getTime() - t;
	const abs = Math.abs(diff);
	if (abs < MIN) return diff >= 0 ? "just now" : "in less than a minute";
	const text = abs < HOUR ? unit(Math.floor(abs / MIN), "minute") : abs < DAY ? unit(Math.floor(abs / HOUR), "hour") : unit(Math.floor(abs / DAY), "day");
	return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** Whole days between an instant and now, never negative. */
export function daysBetween(fromIso: string, now: Date): number {
	const t = Date.parse(fromIso);
	if (Number.isNaN(t)) return 0;
	return Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "2026-11-01" in UTC, so output does not depend on the machine's time zone. */
export function formatDate(iso: string): string {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? "unknown date" : new Date(t).toISOString().slice(0, 10);
}

export function formatDateTime(iso: string): string {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? "unknown time" : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
