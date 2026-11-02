export interface SafeStorageLike {
	isAsyncEncryptionAvailable(): Promise<boolean>;
	getSelectedStorageBackend?: () => string;
	encryptStringAsync(plain: string): Promise<Buffer>;
	decryptStringAsync(data: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}
export interface KeyStorageService {
	status(): Promise<{ available: true; protection: string; backend: string } | { available: false; reason: string; backend?: string }>;
	load(): Promise<string | null>;
	save(bundle: string): Promise<void>;
	clear(): Promise<void>;
}
export const CHANNEL: "lh:keystorage";
export const LINUX_BACKENDS: string[];
export function createKeyStorageService(opts: { safeStorage: SafeStorageLike; filePath: string; platform?: NodeJS.Platform }): KeyStorageService;
export function attachKeyStorageChild(
	child: { connected: boolean; send(m: unknown, cb?: () => void): unknown; on(e: "message", l: (m: any) => void): unknown; removeListener(e: "message", l: (m: any) => void): unknown },
	service: KeyStorageService,
): { dispose(): void };
export function validateRequest(message: unknown): string | null;
