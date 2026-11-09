# Vault protocol: byte formats

Status: frozen for the beta (2026-11-01, #13). Normative. The HTTP API is in [api.md](api.md).

This document fixes every byte format of the vault so that the Go code (`internal/protocol`, server, `lhv-decrypt`) and the TypeScript client (`client/src/crypto`) cannot drift. The test vectors in [`vectors/`](vectors) are part of the spec: where this text and a vector disagree, the vector wins until the text is fixed. Both test suites load every vector file (`internal/protocol/vectors_test.go`, `client/test/vectors.test.ts`). `npm run vectors` in `client/` regenerates them from fixed keys and nonces; CI fails if the committed files differ from the output.

Terms are defined in the [glossary](../glossary.md). Decisions behind the formats are in ADR 0002, 0003, 0005 and 0010.

## 1. Notation

- `||` concatenates byte strings. A quoted string such as `"lhv1/wrap/"` stands for its UTF-8 bytes.
- `H_n(key = k, m)` is libsodium `crypto_generichash` (BLAKE2b) with output length `n` bytes, key `k` and message `m`. `H_n(m)` has no key.
- `u32(n)` is `n` as 4 bytes big-endian.
- `lp(x)` is `u32(len(x)) || x`, a length-prefixed variable field.
- `AEAD(k, nonce, m, ad)` is XChaCha20-Poly1305 IETF (`crypto_aead_xchacha20poly1305_ietf_encrypt`): 32-byte key, 24-byte nonce, 16-byte tag appended.
- `seal(m, pk)` is `crypto_box_seal`: `epk(32) || crypto_box_easy(m, nonce = H_24(epk || pk), pk, esk)`, 48 bytes of overhead.
- `boxKeyPair(seed)` is `crypto_box_seed_keypair`: `sk = SHA-512(seed)[0:32]`, `pk = X25519(sk, 9)` (X25519 clamps). Go must derive it this way; it is not `curve25519` with the seed as secret key.
- `signKeyPair(seed)` is `crypto_sign_seed_keypair`, equal to Go `ed25519.NewKeyFromSeed`.
- Every nonce is 24 random bytes from the OS CSPRNG, except in test vectors.

## 2. Field formats (framing)

Every keyed hash and associated data concatenates fields whose formats are fixed. A receiver rejects any other form with `bad_format` (`vectors/framing.json`).

| Field | Format |
| --- | --- |
| `accountId` | lowercase hyphenated UUID, 36 characters, `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `g`, `e` (generation, epoch) | integer from 1 to 2^32−1; in text, canonical decimal (no sign, no leading zeros) |
| method `kind` | one of `password`, `passkey`, `recovery_key`, `backup_code`, `device` |
| record `kind` | `doc` or `seg` |
| wrap `name` | `ik` or `vk/<e>` |
| `recordId` | 64 lowercase hex characters |
| `pk`, `ikTag`, `commit`, `pkTag`, tags | 32 bytes |
| `sealed` (root key) | 84 bytes (`32 + 4 + 32 + 16`) |
| `pairingId` | 16 random bytes, base64url without padding (22 characters); always length-prefixed in tags |
| device name | UTF-8, 1 to 64 bytes, no control characters (U+0000–U+001F, U+007F); always length-prefixed in tags |
| LearnHarness device id | `dev_` followed by 8 characters `[a-z0-9]` |
| `accountSalt` | 16 random bytes |

In JSON (API bodies, export manifest) every binary value is base64url without padding. Decoders reject padding and non-canonical encodings. In the test vectors binary values are lowercase hex.

## 3. Keys and wraps

`ARK_g`, `VK_e` and `IK` are 32 bytes from `randombytes_buf`. Generation and epoch start at 1.

```
wrap = nonce(24) || AEAD(ARK_g, nonce, key, ad)                     72 bytes
ad   = "lhv1/wrap/" || accountId || "/" || name || "/" || decimal(g)
name = "ik" for IK, "vk/" || decimal(e) for VK_e
```

The server stores exactly one wrap per name for the current generation: `ik` and `vk/1` … `vk/E`, where `E` is the current epoch. Vectors: `vectors/wrap.json` (wrong name, generation, account or root key, truncation and a flipped bit must fail).

## 4. Unlock methods

Each unlock method owns an X25519 key pair `boxKeyPair(seed)`:

| Kind | `seed` |
| --- | --- |
| `password` | `H_32(key = OPAQUE export_key, "lhv1/unlock/password")` |
| `passkey` | `H_32(key = PRF output, "lhv1/unlock/passkey")`; the WebAuthn PRF `eval.first` input is the UTF-8 bytes of `"lhv1/unlock/passkey"` |
| `recovery_key`, `backup_code` | `material[0:32]` (section 6) |
| `device` | 32 random bytes kept on the device |

Per method the server stores `kind`, `pk`, `sealed`, `commit` and `pkTag`:

```
sealed    = seal(u32(g) || ARK_g, pk)
ikTag     = H_32(key = IK, "lhv1/ik-tag")
commitKey = H_32(key = seed, "lhv1/commit-key")
commit    = H_32(key = commitKey, "lhv1/commit/" || accountId || "/" || kind || "/" || pk || ikTag)
pkTagKey  = H_32(key = IK, "lhv1/pk-tag-key")
pkTag     = H_32(key = pkTagKey, "lhv1/method-pk/" || accountId || "/" || kind || "/" || pk)
```

Opening `sealed` yields 36 bytes; `g` must be from 1 to 2^32−1. Vectors: `vectors/unlock.json` holds every kind with seed, key pair, commitment, pkTag and a deterministic seal (`ephemeralSeed` replaces the random ephemeral key so the vector is reproducible), plus commitments and tags of the wrong kind, account, index key or method, and seals that are truncated, flipped, addressed to another method or carry generation 0.

## 5. Key acceptance (ADR 0002)

A device applies these rules, and only these rules decide whether key material is trusted.

1. **Unlock.** Derive the method key pair from its seed and check that `pk` matches the method row. Refuse a method with no `commit` (`no_commitment`). Open `sealed`; its `g` must equal the generation the server reports. Unwrap `ik` and `vk/1..E` under `ARK_g`. Recompute `commit` with the unwrapped `IK`; on mismatch abort with `foreign_key` and the message "The server returned key material that does not belong to this account".
2. **Rotation acceptance.** A device holding `ARK_g`, `IK` and `VK_1..VK_e` accepts `ARK_g'` only if `g' > g`, the new wraps (under `g'`) return the same `IK` and the same `VK_1..VK_e`, and at least one new vault key (`e' > e`). A different root key with `g' = g` is rejected, as is a rotation without a new vault key (`rotation_rejected`).
3. **No rollback.** A device stores the highest `g` and `e` it accepted next to its keys and refuses lower values (`rollback`).
4. **Pairing.** A root key that arrives by pairing is accepted only after `approveTag` verifies (section 7).
5. **Public key authenticity.** Before sealing to any method (rotation, pairing approval, re-seal), recompute `pkTag` and refuse on mismatch (`pk_tag_mismatch`). A device also pins the `pk` of every method it verified, keyed by method id, and refuses a changed `pk` until the learner confirms it.
6. **Records.** After decrypting a record, `recordId` of the header's `path` must equal the record id it was stored under and the header's `kind` must equal the stored kind (`wrong_record`).

Vectors: `vectors/rotation.json` (honest rotation, two rotations at once; changed `vk/1`, changed `IK`, no new key, same generation, wraps under another generation, a missing wrap; rollback below the high-water mark).

## 6. Recovery key and backup codes (ADR 0005)

Text uses Crockford Base32 with alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Decoding is case-insensitive, ignores dashes, maps `O` to `0` and `I`, `L` to `1`, and rejects wrong lengths, other characters and values that set padding bits (`bad_code`). The value is big-endian and left-padded with zero bits to whole bytes (`secretBytes`).

| Secret | Random bits | Characters | Display | `secretBytes` |
| --- | --- | --- | --- | --- |
| recovery key | 160 | 32 | 8 groups of 4, `ABCD-EFGH-…` | 20 |
| backup code | 100 | 20 | 4 groups of 5 | 13 (top 4 bits zero) |
| pairing secret | 256 | 52 | no groups | 32 (4 padding bits, first character `0`–`F`) |

```
material  = H_64(key = accountSalt, "lhv1/recovery/" || kind || "/" || secretBytes)
unlock    = boxKeyPair(material[0:32])            the unlock method; material[0:32] is its seed
auth      = signKeyPair(material[32:64])          the server stores auth.pk
challenge = 32 random bytes from the server
proof     = Ed25519 signature by auth.sk over "lhv1/recover/" || accountId || challenge
```

The recovery derivation version is 1. Vectors: `vectors/recovery.json` (both kinds with material, key pairs and a deterministic signature; lower case, missing dashes and `O`/`I`/`L` variants; bad lengths and characters).

## 7. Pairing (ADR 0003)

```
QR payload = "lhv1-pair:" || serverUrl || ":" || pairingId || ":" || base64url(secret)
text       = Crockford(secret), 52 characters
joinTag    = H_32(key = secret, "lhv1/pair/join" || lp(pairingId) || pk || lp(name) || lp(lhDeviceId) || u8(ephemeral ? 1 : 0))
sealed     = seal(u32(g) || ARK_g, pk)
approveTag = H_32(key = secret, "lhv1/pair/approve" || lp(pairingId) || pk || sealed)
code       = decimal(u32 big-endian of H_4("lhv1/pair/code" || pk) mod 1000000), left-padded with zeros to 6 digits
```

`serverUrl` is an `http` or `https` URL and may contain colons, so a parser splits the last two `:`-separated fields off from the right. `pk` is the new device's `device` public key, `name` its device name, `lhDeviceId` its LearnHarness device id (`dev_` plus 8 characters of `[0-9a-z]`) and `ephemeral` whether it is a session-mode device. `lhDeviceId` and `ephemeral` are stored by the server and used at approval, so the tag binds them; the approving device verifies the tag with the values from the server's join record. Vectors: `vectors/pairing.json` (payload, text, tag inputs, tags, codes; a padding bit in the text, wrong name, key, pairing id, LearnHarness device id, ephemeral flag, sealed key or secret; malformed payloads).

## 8. Records

```
recordId  = hex(H_32(key = IK, path))
plaintext = u32(len(header)) || header || body
envelope  = 0x01 || u32(e) || nonce(24) || AEAD(VK_e, nonce, plaintext, ad)
ad        = "lhv1/rec/" || accountId || "/" || recordId || "/" || kind
```

A record path is 1 to 1024 bytes of UTF-8, relative, with `/` separators, no empty, `.` or `..` segment and no backslash. The prefix `lhv1/` is reserved and rejected: `recordId` and several key-derivation labels (for example `pkTagKey = H_32(key = IK, "lhv1/pk-tag-key")`) use the same keyed hash, so a record at path `lhv1/pk-tag-key` would have the key itself as its record id. The header is UTF-8 JSON, at most 64 KiB, with these fields (writers emit them in this order; readers accept any order and reject missing or mistyped fields):

```
document: {"kind":"doc","path":…,"baseSeq":n,"deleted":bool,"deviceId":"dev_…","writtenAt":RFC 3339}
segment:  {"kind":"seg","path":…,"ledger":name,"deviceId":"dev_…","offset":n,"writtenAt":RFC 3339}
```

`baseSeq` is the seq the write was based on (0 for a new document). `deleted: true` makes the version a tombstone; its body is empty. `ledger` matches `^[a-z][a-z0-9_-]{0,31}$`; `offset` is the byte offset of the body in the ledger file. Segment paths are `ledger/<ledger>/<deviceId>/<offset as 12 decimal digits>` or `ledger/<ledger>/base/<offset>` (ADR 0007). The plaintext is at most 32 MiB.

The header carries `kind` so that rule 6 of section 5 can compare it with the stored kind. The server reads only the first 5 bytes of an envelope (version and epoch) and checks that the epoch equals the declared one.

Vectors: `vectors/record.json` (record ids, invalid paths, a document, a tombstone and a segment; wrong account, record id or kind in the associated data, truncation, unknown version, an epoch the device lacks, a header path that does not match the id, and a header kind that does not match).

## 9. Export archive (ADR 0010)

`lhv-export-<yyyymmdd>.tar` is a POSIX ustar archive with `manifest.json` first, then one entry `blobs/<sha256 hex>` per distinct blob. `manifest.json`:

```json
{
  "format": "lhv-export", "version": 1,
  "accountId": "…", "createdAt": "RFC 3339", "serverUrl": "https://…",
  "accountSalt": "b64", "recoveryDerivation": 1,
  "generation": g, "epoch": e,
  "methods": [{ "kind": "recovery_key" | "backup_code", "publicKey": "b64", "sealed": "b64", "commit": "b64" }],
  "wraps":   [{ "name": "ik" | "vk/<e>", "wrap": "b64" }],
  "records": [{ "recordId": "hex", "kind": "doc" | "seg", "seq": n, "epoch": e, "blob": "blobs/<sha256>" }]
}
```

`records` lists heads only. To decrypt: parse the recovery key or backup code, derive `material` with `accountSalt`, find the method of that kind whose `publicKey` matches, unlock under rules 1 and 6 of section 5, then decrypt every record. Documents go to their record path; tombstoned documents are not written. Segments rebuild `graph/<ledger>.<deviceId>.jsonl` (or `graph/<ledger>.jsonl` for `base`) by concatenating bodies in offset order; a gap or overlap stops that ledger at the gap and is reported. Vectors: `vectors/export.json` (a manifest with two methods, two epochs, a document, a tombstone and two segments; both secrets must produce `files`).

## 10. Versioning

Every label starts with `lhv1/`, the envelope starts with version byte `0x01`, and the export manifest has `version: 1`. A change to any format in this document needs a new label or version, new vectors, and both implementations in the same commit (ADR 0001).
