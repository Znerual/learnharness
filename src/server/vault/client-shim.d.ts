/**
 * Stand-in types for @znerual/learnharness-vault-client, used ONLY when the package is not
 * installed (tsconfig.json "paths" lists the real package first and this file second), so that
 * `npm run typecheck` passes in a public build without the private package. With the package
 * installed this file is never read and everything below is checked against the real types.
 *
 * Everything is `any` except what the fork implements itself (KeyStorage), because the real
 * declarations are the vault repo's and live there.
 */

export type SecretBundle = any;
export type KeyStorageErrorCode = "no_secure_storage" | "locked" | "corrupt" | "io";
export type KeyStorageStatus = { available: true; protection: string; backend?: string } | { available: false; reason: string; backend?: string };
export type NoSecureStorageReason = string;
export interface KeyStorage {
	status(): Promise<KeyStorageStatus>;
	load(): Promise<SecretBundle | null>;
	save(bundle: SecretBundle): Promise<void>;
	clear(): Promise<void>;
}
export declare class KeyStorageError extends Error {
	readonly code: KeyStorageErrorCode;
	constructor(code: KeyStorageErrorCode, message?: string);
}
export declare function encodeBundle(b: SecretBundle): string;
export declare function decodeBundle(s: string): SecretBundle;
export declare class MemoryKeyStorage implements KeyStorage {
	status(): Promise<KeyStorageStatus>;
	load(): Promise<SecretBundle | null>;
	save(bundle: SecretBundle): Promise<void>;
	clear(): Promise<void>;
}

export type Vault = any;
export declare const Vault: any;
export type SyncEngine = any;
export declare const SyncEngine: any;
export type SyncEngineOptions = any;
export type SyncReport = any;
export type JoinerPairing = any;
export type Restorer = any;
export declare const Restorer: any;
export interface AppliedChange {
	path: string;
	kind: string;
	deleted: boolean;
}
export declare class FsHost {
	constructor(root: string);
	readonly root: string;
	readDocument(path: string): Promise<Uint8Array | null>;
	writeConflict(path: string, data: Uint8Array): Promise<void>;
	deleteDocument(path: string): Promise<void>;
	listFiles(): Promise<string[]>;
	applied(changes: AppliedChange[]): void;
	[member: string]: any;
}
export type ChangesResponse = any;
export declare const crypto: any;
export declare const checkPassword: any;
export declare const leaveVault: any;
export declare const parseLedgerFile: any;
export declare const isDocumentPath: any;
