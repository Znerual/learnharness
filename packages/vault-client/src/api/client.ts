// HTTP client for the vault API (docs/protocol/api.md). Binary values travel as base64url.

import { fromB64, toB64 } from "../crypto/bytes.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** An error response of the API: HTTP status, stable code and extra fields. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly body: Record<string, unknown>;
	constructor(status: number, code: string, message: string, body: Record<string, unknown>) {
		super(`${status} ${code}: ${message}`);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

/** A network failure (no HTTP response). The sync engine treats it as offline. */
export class NetworkError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NetworkError";
	}
}

export interface RequestOptions {
	token?: string | undefined;
	reauth?: string | undefined;
	pairingToken?: string | undefined;
	signal?: AbortSignal | undefined;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Limits on what the server may send. The vault server is not trusted (ADR 0002): without them a
// hostile or broken server could hand the device an endless or huge answer and exhaust its memory,
// or never answer and stall sync for good.
/** A record envelope: the 32 MiB record limit plus envelope overhead (the server allows 32 MiB + 1 KiB). */
export const MAX_BLOB_RESPONSE = 32 * 1024 * 1024 + 64 * 1024;
/** A JSON answer. The largest honest one is a history listing of every record version of an account. */
export const MAX_JSON_RESPONSE = 128 * 1024 * 1024;
const MAX_ERROR_RESPONSE = 64 * 1024;
/** Time for a JSON request and its answer. */
export const JSON_TIMEOUT_MS = 2 * 60_000;
/** Time for an upload batch or a blob download (64 MiB on a slow line). */
export const TRANSFER_TIMEOUT_MS = 20 * 60_000;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** The caller's signal plus a time limit. */
function limited(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Reads a response body, at most max bytes. A longer body is an error, and the rest is not read. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > max) {
		await res.body?.cancel().catch(() => undefined);
		throw new NetworkError(`the vault server's answer is too large (${declared} bytes, at most ${max})`);
	}
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			throw new NetworkError(`the vault server's answer is too large (over ${max} bytes)`);
		}
		chunks.push(value);
	}
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

export class ApiClient {
	readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;

	constructor(baseUrl: string, fetchImpl?: FetchLike) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.fetchImpl = fetchImpl ?? ((i, init) => fetch(i, init));
	}

	private headers(o: RequestOptions, json: boolean): Record<string, string> {
		const h: Record<string, string> = {};
		if (json) h["content-type"] = "application/json";
		if (o.token) h["authorization"] = `Bearer ${o.token}`;
		if (o.reauth) h["lhv-reauth"] = o.reauth;
		if (o.pairingToken) h["lhv-pairing-token"] = o.pairingToken;
		return h;
	}

	/**
	 * Sends a request and returns the response with its body unread. The caller bounds the body.
	 * Redirects are refused: the API never redirects, and a redirect would carry the re-authentication
	 * and pairing headers (and, within the same origin, the device token) wherever the server points.
	 */
	async raw(method: string, path: string, o: RequestOptions & { body?: FormData | Uint8Array | string } = {}): Promise<Response> {
		const headers = this.headers(o, false);
		let res: Response;
		try {
			res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: (o.body ?? null) as NonNullable<RequestInit["body"]> | null, signal: o.signal ?? null, redirect: "error" });
		} catch (e) {
			throw new NetworkError(`cannot reach the vault server: ${(e as Error).message}`, { cause: e });
		}
		if (!res.ok) await throwApiError(res);
		return res;
	}

	async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
		let res: Response;
		try {
			res = await this.fetchImpl(this.baseUrl + path, {
				method,
				headers: this.headers(o, body !== undefined),
				body: body === undefined ? null : JSON.stringify(body),
				signal: limited(o.signal, JSON_TIMEOUT_MS),
				redirect: "error",
			});
		} catch (e) {
			throw new NetworkError(`cannot reach the vault server: ${(e as Error).message}`, { cause: e });
		}
		if (!res.ok) await throwApiError(res);
		return (await readJson(res, MAX_JSON_RESPONSE)) as T;
	}

	get<T = Record<string, unknown>>(path: string, o: RequestOptions = {}): Promise<T> {
		return this.json<T>("GET", path, undefined, o);
	}

	post<T = Record<string, unknown>>(path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
		return this.json<T>("POST", path, body, o);
	}

	/** Downloads a blob by sha256. */
	async blob(sha256: string, o: RequestOptions): Promise<Uint8Array> {
		// The hash comes from the server's change list and goes into the URL.
		if (!SHA256_RE.test(sha256)) throw new Error("the vault server named a blob that is not a SHA-256");
		const res = await this.raw("GET", `/v1/blobs/${sha256}`, { ...o, signal: limited(o.signal, TRANSFER_TIMEOUT_MS) });
		return readBody(res, MAX_BLOB_RESPONSE);
	}

	/** Posts a multipart body (records batch or re-encryption). */
	async multipart<T>(path: string, form: FormData, o: RequestOptions): Promise<T> {
		const res = await this.raw("POST", path, { ...o, body: form, signal: limited(o.signal, TRANSFER_TIMEOUT_MS) });
		return (await readJson(res, MAX_JSON_RESPONSE)) as T;
	}

	/** The WebSocket URL of the event stream. */
	eventsUrl(): string {
		return `${this.baseUrl.replace(/^http/, "ws")}/v1/events`;
	}
}

/** Reads a body; a failure while reading (timeout, broken connection) is a network failure. */
export async function readBody(res: Response, max: number): Promise<Uint8Array> {
	try {
		return await readCapped(res, max);
	} catch (e) {
		if (e instanceof NetworkError) throw e;
		throw new NetworkError(`cannot read the vault server's answer: ${(e as Error).message}`, { cause: e });
	}
}

async function readJson(res: Response, max: number): Promise<unknown> {
	const text = new TextDecoder().decode(await readBody(res, max));
	return text ? JSON.parse(text) : {};
}

async function throwApiError(res: Response): Promise<never> {
	let body: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(await readCapped(res, MAX_ERROR_RESPONSE)));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
	} catch {
		// non-JSON, oversized or unreadable error body
	}
	throw new ApiError(res.status, typeof body["error"] === "string" ? body["error"] : `http_${res.status}`, typeof body["message"] === "string" ? body["message"] : res.statusText, body);
}

/** Encodes bytes for JSON. */
export const b64 = toB64;
/** Decodes a base64url JSON field. */
export function unb64(v: unknown): Uint8Array {
	if (typeof v !== "string") throw new Error("expected a base64url string");
	return fromB64(v);
}
