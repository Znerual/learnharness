// Field formats from ADR 0002, Framing. Every keyed hash and associated data input is built
// only from values that pass these checks.

import { ProtocolError } from "./errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const METHOD_KINDS = ["password", "passkey", "recovery_key", "backup_code", "device"] as const;
export type MethodKind = (typeof METHOD_KINDS)[number];

export const RECORD_KINDS = ["doc", "seg"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export function checkAccountId(accountId: string): string {
	if (!UUID_RE.test(accountId)) throw new ProtocolError("bad_format", "accountId must be a lowercase hyphenated UUID");
	return accountId;
}

export function checkMethodKind(kind: string): MethodKind {
	if (!(METHOD_KINDS as readonly string[]).includes(kind)) throw new ProtocolError("bad_format", `unknown unlock method kind: ${kind}`);
	return kind as MethodKind;
}

export function checkRecordKind(kind: string): RecordKind {
	if (!(RECORD_KINDS as readonly string[]).includes(kind)) throw new ProtocolError("bad_format", `unknown record kind: ${kind}`);
	return kind as RecordKind;
}

/** Generation and epoch numbers: integers from 1 to 2^32 - 1. */
export function checkCounter(n: number, what: string): number {
	if (!Number.isSafeInteger(n) || n < 1 || n > 0xffffffff) throw new ProtocolError("bad_format", `${what} must be an integer from 1 to 2^32-1`);
	return n;
}

/** Canonical decimal: no sign, no leading zeros. Used to parse numbers that arrive as text. */
export function parseCanonicalDecimal(s: string, what: string): number {
	if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new ProtocolError("bad_format", `${what} is not canonical decimal`);
	const n = Number(s);
	if (!Number.isSafeInteger(n)) throw new ProtocolError("bad_format", `${what} is out of range`);
	return n;
}

/** Wrap names: "ik" or "vk/<e>" with canonical decimal e. */
export function checkWrapName(name: string): string {
	if (name === "ik") return name;
	const m = /^vk\/(.+)$/.exec(name);
	if (m?.[1] === undefined) throw new ProtocolError("bad_format", `bad wrap name: ${name}`);
	checkCounter(parseCanonicalDecimal(m[1], "wrap epoch"), "wrap epoch");
	return name;
}

export function vkName(epoch: number): string {
	return `vk/${checkCounter(epoch, "epoch")}`;
}
