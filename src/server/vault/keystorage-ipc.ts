// Server-process side of the `lh:keystorage` bridge (issue #65): the KeyStorage port over the
// inherited Node child IPC channel to the Electron main process (keystorage-main.cjs).
// Binary values never cross as binary: the bundle travels as the port's encodeBundle() JSON string.

import {
	decodeBundle, encodeBundle, KeyStorageError,
	type KeyStorage, type KeyStorageErrorCode, type KeyStorageStatus, type SecretBundle,
} from "@znerual/learnharness-vault-client";

export const CHANNEL = "lh:keystorage";

/** The part of `process` this adapter needs; injectable for tests. */
export interface IpcProcess {
	send?: (message: unknown, cb?: (err: Error | null) => void) => boolean;
	connected?: boolean;
	on(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
	removeListener(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
}

export interface IpcKeyStorageOptions {
	proc?: IpcProcess;
	timeoutMs?: number;
}

type Pending = { op: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const CODES: readonly KeyStorageErrorCode[] = ["no_secure_storage", "locked", "corrupt", "io"];

export class IpcKeyStorage implements KeyStorage {
	private readonly proc: IpcProcess;
	private readonly timeoutMs: number;
	private readonly pending = new Map<string, Pending>();
	private seq = 0;
	private attached = false;

	constructor(opts: IpcKeyStorageOptions = {}) {
		this.proc = opts.proc ?? (process as unknown as IpcProcess);
		this.timeoutMs = opts.timeoutMs ?? 10_000;
	}

	/** True when this process was spawned with an IPC channel (the desktop app, not `next dev`). */
	get hasBridge(): boolean {
		return typeof this.proc.send === "function" && this.proc.connected === true;
	}

	async status(): Promise<KeyStorageStatus> {
		if (!this.hasBridge) return { available: false, reason: "bridge_missing" };
		try {
			return (await this.call("status")) as KeyStorageStatus;
		} catch (e) {
			if (e instanceof KeyStorageError && e.code === "io") return { available: false, reason: "bridge_missing" };
			throw e;
		}
	}

	async load(): Promise<SecretBundle | null> {
		const s = (await this.call("load")) as string | null;
		return s === null ? null : decodeBundle(s);
	}

	async save(bundle: SecretBundle): Promise<void> {
		await this.call("save", { bundle: encodeBundle(bundle) });
	}

	async clear(): Promise<void> {
		// Without a bridge nothing was ever stored by this adapter.
		if (!this.hasBridge) return;
		await this.call("clear");
	}

	private call(op: "status" | "load" | "save" | "clear", extra: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.hasBridge) return Promise.reject(new KeyStorageError("no_secure_storage", "bridge_missing"));
		this.attach();
		const id = `ks-${process.pid}-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new KeyStorageError("io", `lh:keystorage ${op} timed out`));
			}, this.timeoutMs);
			this.pending.set(id, { op, resolve, reject, timer });
			try {
				this.proc.send!({ channel: CHANNEL, id, op, ...extra }, (err) => {
					if (err) this.settle(id, (p) => p.reject(new KeyStorageError("io", err.message)));
				});
			} catch (e) {
				this.settle(id, (p) => p.reject(new KeyStorageError("io", (e as Error).message)));
			}
		});
	}

	private settle(id: string, fn: (p: Pending) => void): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		fn(p);
	}

	private attach(): void {
		if (this.attached) return;
		this.attached = true;
		this.proc.on("message", (m: unknown) => this.onMessage(m));
		this.proc.on("disconnect", () => {
			for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(new KeyStorageError("io", "IPC channel closed")));
		});
	}

	private onMessage(m: unknown): void {
		const msg = m as { channel?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } };
		if (!msg || msg.channel !== CHANNEL || typeof msg.id !== "string") return;
		this.settle(msg.id, (p) => {
			if (msg.ok === true) return p.resolve(msg.value);
			const code = CODES.find((c) => c === msg.error?.code) ?? "io";
			p.reject(new KeyStorageError(code, typeof msg.error?.message === "string" ? msg.error.message : code));
		});
	}
}
