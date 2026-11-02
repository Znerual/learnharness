export const CHANNEL: "lh:passkey";
export const PARTITION: string;
export function passkeyHost(vaultUrl: string): string | null;
export type Route = { kind: "static"; file: string; type: string } | { kind: "api"; url: string } | { kind: "deny"; status: number };
export function routeRequest(url: string, method: string, opts: { host: string; apiBase?: string | undefined }): Route;
export function validateCeremonyRequest(message: unknown): string | null;
export function stripPrfResults(credential: Record<string, any>): Record<string, any>;
export function sanitizePageResult(
	result: unknown,
): { ok: true; value: { credential: Record<string, any>; prfOutput: string | null; prfEnabled: boolean } } | { ok: false; error: { name: string; message: string } };
export function createPasskeyCeremony(opts: { host: string; apiBase?: string; parent?: unknown; timeoutMs?: number }): {
	run(request: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { name: string; message: string } }>;
};
export function attachPasskeyChild(
	child: { connected: boolean; send(m: unknown, cb?: () => void): unknown; on(e: "message", l: (m: any) => void): unknown; removeListener(e: "message", l: (m: any) => void): unknown },
	ceremony: { run(request: unknown): Promise<any> },
): { dispose(): void };
