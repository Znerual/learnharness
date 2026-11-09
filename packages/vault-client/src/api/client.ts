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

	async raw(method: string, path: string, o: RequestOptions & { body?: FormData | Uint8Array | string } = {}): Promise<Response> {
		const headers = this.headers(o, false);
		let res: Response;
		try {
			res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: (o.body ?? null) as NonNullable<RequestInit["body"]> | null, signal: o.signal ?? null });
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
				signal: o.signal ?? null,
			});
		} catch (e) {
			throw new NetworkError(`cannot reach the vault server: ${(e as Error).message}`, { cause: e });
		}
		if (!res.ok) await throwApiError(res);
		const text = await res.text();
		return (text ? JSON.parse(text) : {}) as T;
	}

	get<T = Record<string, unknown>>(path: string, o: RequestOptions = {}): Promise<T> {
		return this.json<T>("GET", path, undefined, o);
	}

	post<T = Record<string, unknown>>(path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
		return this.json<T>("POST", path, body, o);
	}

	/** Downloads a blob by sha256. */
	async blob(sha256: string, o: RequestOptions): Promise<Uint8Array> {
		const res = await this.raw("GET", `/v1/blobs/${sha256}`, o);
		return new Uint8Array(await res.arrayBuffer());
	}

	/** Posts a multipart body (records batch or re-encryption). */
	async multipart<T>(path: string, form: FormData, o: RequestOptions): Promise<T> {
		const res = await this.raw("POST", path, { ...o, body: form });
		return (await res.json()) as T;
	}

	/** The WebSocket URL of the event stream. */
	eventsUrl(): string {
		return `${this.baseUrl.replace(/^http/, "ws")}/v1/events`;
	}
}

async function throwApiError(res: Response): Promise<never> {
	let body: Record<string, unknown> = {};
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		// non-JSON error body
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
