export type ProtocolErrorCode =
	| "bad_format" //        input does not match a fixed field format
	| "decrypt_failed" //    authentication of a ciphertext failed (wrong key, associated data or tampering)
	| "wrong_record" //      a decrypted record does not match its record id or kind
	| "foreign_key" //       key commitment mismatch: the server returned key material of another account
	| "no_commitment" //     an unlock method without a commitment cannot unlock
	| "pk_tag_mismatch" //   an unlock method's public key does not match its pkTag
	| "rotation_rejected" // a new generation failed rotation acceptance
	| "rollback" //          a generation or epoch lower than one already accepted
	| "pairing_tag" //       a pairing tag did not verify
	| "bad_code"; //         a recovery key, backup code or pairing text is malformed

export class ProtocolError extends Error {
	readonly code: ProtocolErrorCode;
	constructor(code: ProtocolErrorCode, message: string) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
	}
}

/** The message ADR 0002 requires when a key commitment check fails. */
export const FOREIGN_KEY_MESSAGE = "The server returned key material that does not belong to this account";
