import type { SafeStorageLike } from "../electron/keystorage-main.cjs";

export interface FakeOptions {
	backend?: string;
	/** Ciphertext prefix: v11 = keyring-backed, v10 = hard-coded fallback. */
	prefix?: "v10" | "v11";
	/** When false, isAsyncEncryptionAvailable() is false and encryption throws. */
	available?: boolean;
	/** Makes every encryption throw with this message. */
	throwOnEncrypt?: string;
}

/** Fake with Electron's observable behaviour; "encryption" is a reversible XOR that is not secret. */
export function fakeSafeStorage(o: FakeOptions = {}): SafeStorageLike & { keyId: number; encrypted: number } {
	const prefix = o.prefix ?? "v11";
	const fake = {
		keyId: 1,
		encrypted: 0,
		getSelectedStorageBackend: () => o.backend ?? "gnome_libsecret",
		async isAsyncEncryptionAvailable() {
			return o.available ?? true;
		},
		async encryptStringAsync(plain: string) {
			if (o.available === false) throw new Error("Encryption is not available");
			if (o.throwOnEncrypt) throw new Error(o.throwOnEncrypt);
			fake.encrypted++;
			const body = Buffer.from(plain, "utf8").map((b) => b ^ 0x5a);
			return Buffer.concat([Buffer.from(prefix, "latin1"), Buffer.from([fake.keyId]), body]);
		},
		async decryptStringAsync(data: Buffer) {
			if (data.length < 4 || data.subarray(0, 3).toString("latin1") !== prefix) throw new Error("bad prefix");
			if (data[3] !== fake.keyId) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
			return { shouldReEncrypt: false, result: Buffer.from(data.subarray(4).map((b) => b ^ 0x5a)).toString("utf8") };
		},
	};
	return fake;
}
