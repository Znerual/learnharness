// Three-way merge of plugin files (LearnHarness ADR 0007 "Merging", vault ADR 0014 "Conflicts").
// The common ancestor is the last synced version; local is this device's file; remote is the
// vault's newer version. The result is deterministic: the same three inputs give the same bytes on
// every device.
//
// JSON: objects merge key by key; arrays whose elements are all objects with a unique string `id`
// merge as sets by id; other arrays merge element by element (diff3), keeping insertions from both
// sides; a value deleted on one side and changed on the other is kept with the change; a value
// changed differently on both sides takes the remote value and is reported as a conflict.
// Text (md, txt, jsonl): lines, the same way as other arrays. Binary: the remote version wins
// when both sides changed.

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export type MergeKind = "json" | "text" | "binary";

export interface MergeResult {
	merged: Uint8Array;
	/** Where both sides changed the same value or lines; the remote version was kept there. */
	conflicts: string[];
}

/** The merge kind for a file, by extension. */
export function mergeKindFor(path: string): MergeKind {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "json") return "json";
	if (ext === "jsonl" || ext === "md" || ext === "txt") return "text";
	return "binary";
}

function bytesEq(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Merges three versions of a file. `base` is null when there is no common ancestor. */
export function merge3(base: Uint8Array | null, local: Uint8Array, remote: Uint8Array, kind: MergeKind): MergeResult {
	if (bytesEq(local, remote) || bytesEq(base, remote)) return { merged: local, conflicts: [] };
	if (bytesEq(base, local)) return { merged: remote, conflicts: [] };
	if (kind === "json") {
		const r = mergeJsonBytes(base, local, remote);
		if (r) return r;
		return mergeTextBytes(base, local, remote);
	}
	if (kind === "text") return mergeTextBytes(base, local, remote);
	return { merged: remote, conflicts: ["(file)"] };
}

// ---------------------------------------------------------------- sequences (diff3)

/**
 * Longest-common-subsequence matching by Myers' algorithm. Returns pairs [i, j] with a[i] === b[j],
 * increasing in both, or null when the edit distance exceeds `maxD`.
 */
export function matchSequences(a: readonly number[], b: readonly number[], maxD = 4000): [number, number][] | null {
	const n = a.length;
	const m = b.length;
	// Common prefix and suffix first: most edits are small.
	let pre = 0;
	while (pre < n && pre < m && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
	const A = a.slice(pre, n - suf);
	const B = b.slice(pre, m - suf);
	const N = A.length;
	const M = B.length;
	const pairs: [number, number][] = [];
	for (let k = 0; k < pre; k++) pairs.push([k, k]);
	if (N > 0 && M > 0) {
		const max = N + M;
		const off = max;
		let v: Int32Array = new Int32Array(2 * max + 2);
		const trace: Int32Array[] = [];
		let found = -1;
		for (let d = 0; d <= Math.min(max, maxD); d++) {
			trace.push(v.slice());
			for (let k = -d; k <= d; k += 2) {
				let x = k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number)) ? (v[off + k + 1] as number) : (v[off + k - 1] as number) + 1;
				let y = x - k;
				while (x < N && y < M && A[x] === B[y]) {
					x++;
					y++;
				}
				v[off + k] = x;
				if (x >= N && y >= M) {
					found = d;
					break;
				}
			}
			if (found >= 0) break;
		}
		if (found < 0) return null;
		// Backtrack.
		const mid: [number, number][] = [];
		let x = N;
		let y = M;
		for (let d = found; d > 0; d--) {
			v = trace[d] as Int32Array;
			const k = x - y;
			const prevK = k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number)) ? k + 1 : k - 1;
			const prevX = v[off + prevK] as number;
			const prevY = prevX - prevK;
			while (x > prevX && y > prevY) {
				x--;
				y--;
				mid.push([x, y]);
			}
			x = prevX;
			y = prevY;
		}
		while (x > 0 && y > 0) {
			x--;
			y--;
			mid.push([x, y]);
		}
		mid.reverse();
		for (const [i, j] of mid) pairs.push([pre + i, pre + j]);
	}
	for (let k = 0; k < suf; k++) pairs.push([n - suf + k, m - suf + k]);
	return pairs;
}

type Chunk<T> = { stable: true; items: T[] } | { stable: false; base: T[]; local: T[]; remote: T[] };

/** diff3 over sequences compared by `key`. Returns null when a diff is too large. */
function diff3<T>(base: readonly T[], local: readonly T[], remote: readonly T[], key: (t: T) => string): Chunk<T>[] | null {
	const ids = new Map<string, number>();
	const id = (t: T) => {
		const k = key(t);
		let v = ids.get(k);
		if (v === undefined) {
			v = ids.size;
			ids.set(k, v);
		}
		return v;
	};
	const bi = base.map(id);
	const li = local.map(id);
	const ri = remote.map(id);
	const ml = matchSequences(bi, li);
	const mr = matchSequences(bi, ri);
	if (!ml || !mr) return null;
	const toL = new Map(ml);
	const toR = new Map(mr);
	const chunks: Chunk<T>[] = [];
	let i = 0;
	let a = 0;
	let b = 0;
	const push = (c: Chunk<T>) => {
		const last = chunks[chunks.length - 1];
		if (c.stable && last?.stable) last.items.push(...c.items);
		else chunks.push(c);
	};
	while (i <= base.length) {
		let k = i;
		while (k < base.length && !(toL.has(k) && toR.has(k) && (toL.get(k) as number) >= a && (toR.get(k) as number) >= b)) k++;
		if (k >= base.length) {
			if (i < base.length || a < local.length || b < remote.length) push({ stable: false, base: base.slice(i), local: local.slice(a), remote: remote.slice(b) });
			break;
		}
		const lk = toL.get(k) as number;
		const rk = toR.get(k) as number;
		if (k === i && lk === a && rk === b) {
			push({ stable: true, items: [base[k] as T] });
			i++;
			a++;
			b++;
			continue;
		}
		push({ stable: false, base: base.slice(i, k), local: local.slice(a, lk), remote: remote.slice(b, rk) });
		i = k;
		a = lk;
		b = rk;
	}
	return chunks;
}

function seqEq<T>(x: readonly T[], y: readonly T[], key: (t: T) => string): boolean {
	return x.length === y.length && x.every((v, i) => key(v) === key(y[i] as T));
}

/** Merges sequences; insertions on both sides at the same place keep both (remote first). */
function mergeSequence<T>(base: readonly T[], local: readonly T[], remote: readonly T[], key: (t: T) => string, where: string, conflicts: string[]): T[] {
	const chunks = diff3(base, local, remote, key);
	if (!chunks) {
		conflicts.push(where);
		return [...remote];
	}
	const out: T[] = [];
	for (const c of chunks) {
		if (c.stable) {
			out.push(...c.items);
			continue;
		}
		if (seqEq(c.local, c.base, key)) out.push(...c.remote);
		else if (seqEq(c.remote, c.base, key) || seqEq(c.local, c.remote, key)) out.push(...c.local);
		else if (c.base.length === 0) out.push(...c.remote, ...c.local);
		else {
			conflicts.push(where);
			out.push(...c.remote);
		}
	}
	return out;
}

// ---------------------------------------------------------------- text

function splitLines(s: string): string[] {
	if (s === "") return [];
	const parts = s.split("\n");
	const lines = parts.map((p, i) => (i < parts.length - 1 ? `${p}\n` : p));
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function mergeTextBytes(base: Uint8Array | null, local: Uint8Array, remote: Uint8Array): MergeResult {
	let b: string;
	let l: string;
	let r: string;
	try {
		b = base ? dec.decode(base) : "";
		l = dec.decode(local);
		r = dec.decode(remote);
	} catch {
		return { merged: remote, conflicts: ["(file)"] };
	}
	const conflicts: string[] = [];
	const merged = mergeSequence(splitLines(b), splitLines(l), splitLines(r), (x) => x, "(lines)", conflicts);
	return { merged: enc.encode(merged.join("")), conflicts: [...new Set(conflicts)] };
}

// ---------------------------------------------------------------- JSON

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const ABSENT = Symbol("absent");
type Slot = Json | typeof ABSENT;

function canon(v: Slot): string {
	if (v === ABSENT) return "\u0000absent";
	return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

function eq(a: Slot, b: Slot): boolean {
	return canon(a) === canon(b);
}

function isObject(v: Slot): v is { [k: string]: Json } {
	return v !== ABSENT && v !== null && typeof v === "object" && !Array.isArray(v);
}

function idKeyed(...arrays: (Json[] | undefined)[]): boolean {
	for (const arr of arrays) {
		if (!arr) continue;
		const seen = new Set<string>();
		for (const e of arr) {
			if (!isObject(e) || typeof e["id"] !== "string" || seen.has(e["id"] as string)) return false;
			seen.add(e["id"] as string);
		}
	}
	return arrays.some((a) => a && a.length > 0);
}

function pointer(path: string, key: string): string {
	return `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function mergeValue(b: Slot, l: Slot, r: Slot, path: string, conflicts: string[]): Slot {
	if (eq(l, r)) return l;
	if (eq(b, l)) return r;
	if (eq(b, r)) return l;
	// Deleted on one side, changed on the other: the change wins.
	if (l === ABSENT) return r;
	if (r === ABSENT) return l;
	if (isObject(l) && isObject(r)) return mergeObject(isObject(b) ? b : {}, l, r, path, conflicts);
	if (Array.isArray(l) && Array.isArray(r)) {
		const ba = Array.isArray(b) ? b : [];
		if (idKeyed(ba, l, r)) return mergeById(ba, l, r, path, conflicts);
		return mergeSequence(ba, l, r, canon, path || "/", conflicts);
	}
	conflicts.push(path || "/");
	return r;
}

function mergeObject(b: { [k: string]: Json }, l: { [k: string]: Json }, r: { [k: string]: Json }, path: string, conflicts: string[]): { [k: string]: Json } {
	const keys = [...Object.keys(r), ...Object.keys(l).filter((k) => !Object.hasOwn(r, k))];
	for (const k of Object.keys(b)) if (!keys.includes(k)) keys.push(k);
	const out: { [k: string]: Json } = {};
	for (const k of keys) {
		const v = mergeValue(Object.hasOwn(b, k) ? (b[k] as Json) : ABSENT, Object.hasOwn(l, k) ? (l[k] as Json) : ABSENT, Object.hasOwn(r, k) ? (r[k] as Json) : ABSENT, pointer(path, k), conflicts);
		if (v !== ABSENT) out[k] = v;
	}
	return out;
}

/** Arrays of objects with unique string ids: a set by id, in remote order, then local-only elements in local order. */
function mergeById(b: Json[], l: Json[], r: Json[], path: string, conflicts: string[]): Json[] {
	const byId = (arr: Json[]) => new Map(arr.map((e) => [(e as { id: string }).id, e]));
	const bm = byId(b);
	const lm = byId(l);
	const rm = byId(r);
	const order = [...rm.keys()];
	// Local-only ids go right after their local predecessor, so local insertions keep their place.
	const localIds = [...lm.keys()];
	localIds.forEach((idv, i) => {
		if (order.includes(idv)) return;
		let at = 0;
		for (let p = i - 1; p >= 0; p--) {
			const q = order.indexOf(localIds[p] as string);
			if (q >= 0) {
				at = q + 1;
				break;
			}
		}
		order.splice(at, 0, idv);
	});
	for (const idv of bm.keys()) if (!order.includes(idv)) order.push(idv);
	const out: Json[] = [];
	for (const idv of order) {
		const v = mergeValue(bm.has(idv) ? (bm.get(idv) as Json) : ABSENT, lm.has(idv) ? (lm.get(idv) as Json) : ABSENT, rm.has(idv) ? (rm.get(idv) as Json) : ABSENT, pointer(path, idv), conflicts);
		if (v !== ABSENT) out.push(v as Json);
	}
	return out;
}

/** The indentation the remote file was written with, so the merged file looks like the plugin's own. */
function styleOf(text: string, value: Json): { indent: string | number | undefined; newline: boolean } {
	const newline = text.endsWith("\n");
	const body = newline ? text.slice(0, -1) : text;
	for (const indent of [undefined, 2, "\t", 4] as const) if (JSON.stringify(value, null, indent) === body) return { indent, newline };
	return { indent: undefined, newline };
}

function mergeJsonBytes(base: Uint8Array | null, local: Uint8Array, remote: Uint8Array): MergeResult | null {
	let b: Json | undefined;
	let l: Json;
	let r: Json;
	let rText: string;
	try {
		b = base ? (JSON.parse(dec.decode(base)) as Json) : undefined;
		l = JSON.parse(dec.decode(local)) as Json;
		rText = dec.decode(remote);
		r = JSON.parse(rText) as Json;
	} catch {
		return null;
	}
	const conflicts: string[] = [];
	const merged = mergeValue(b === undefined ? ABSENT : b, l, r, "", conflicts);
	const style = styleOf(rText, r);
	const text = JSON.stringify(merged === ABSENT ? null : merged, null, style.indent) + (style.newline ? "\n" : "");
	return { merged: enc.encode(text), conflicts: [...new Set(conflicts)] };
}
