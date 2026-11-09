# Vault HTTP API

Status: beta (2026-11-01, #55). Normative for `internal/server` and `client/src`. Byte formats are in [spec.md](spec.md). Every server change that adds or changes an endpoint updates this file in the same commit.

## Conventions

- Base path `/v1`, JSON bodies (`application/json`), UTF-8. Unknown request fields are rejected with 400, so a request cannot smuggle extra data (for example WebAuthn PRF results).
- Binary values are base64url without padding. Times are RFC 3339 UTC.
- IDs: `accountId`, `deviceId`, method and passkey ids are lowercase UUIDs; `recordId` is 64 hex characters; `pairingId` is 22 base64url characters.
- Request bodies are at most 1 MiB, except `POST /v1/records` (64 MiB of blobs per batch, 32 MiB per record) and `POST /v1/reencrypt` (one record).
- `GET /healthz` answers `{"status":"ok"}` (200) or `{"status":"db_unavailable"}` (503). Prometheus metrics are on a separate private listener (`LHV_METRICS_LISTEN`).

### Authentication

| Credential | Header | Issued by | Lifetime |
| --- | --- | --- | --- |
| Device token | `Authorization: Bearer <token>` | sign-in, signup, recovery, pairing approval | 180 days after the last request (24 h for an ephemeral device); revoked by sign-out, revocation, account deletion |
| Signup token | body field `signupToken` | `POST /v1/signup/verify` | 30 minutes, single use |
| Re-authentication grant | `LHV-Reauth: <grant>` | `/v1/reauth/*` | 5 minutes, one sensitive action, bound to the device token (ADR 0013) |
| Pairing token | `LHV-Pairing-Token: <token>` | `POST /v1/pairing` (joiner shows) or `.../join` | the pairing session (10 minutes) |

The server stores only SHA-256 hashes of tokens and grants. Logs contain no tokens, bodies, query strings or email addresses.

### Errors

Every error body is `{"error": "<code>", "message": "<text>", ...extra}`. The client reacts per code:

| Status | Code | Meaning | Client reaction |
| --- | --- | --- | --- |
| 400 | `bad_request` | malformed request | Bug: report, do not retry. |
| 400 | `invalid_code` | signup code wrong, expired or out of attempts (5) | Ask again; after 5 attempts start signup again. |
| 400 | `no_passkeys` | passkey re-authentication without passkeys | Offer password or recovery material. |
| 401 | `unauthorized` | device token missing, unknown, expired or revoked | Stop sync. Keep local keys; sign in again (ADR 0004). If the device was revoked, leave the vault (ADR 0007). |
| 401 | `login_failed` | wrong email or password (also for unknown emails) | Show "wrong email or password". |
| 401 | `invalid_signup_token` | signup token used or expired | Start signup again. |
| 401 | `recovery_failed` | wrong recovery key or backup code | Show the error; a backup code may already be used. |
| 401 | `passkey_failed` | assertion or attestation invalid, or unknown email | Show "passkey not accepted". |
| 402 | (per write) `quota_exceeded`, `read_only`, `plan_required` | push refused by the quota or the account state (ADR 0009, 0011) | Status "over quota" / "read-only"; keep the outbox, keep pulling; offer "Manage plan". |
| 403 | `reauth_required` | sensitive action without a valid grant | Re-authenticate, then repeat with the new grant. |
| 403 | `account_disabled` | operator disabled the account | Stop; show "contact support". |
| 403 | `not_established` | confirm by a device added less than 24 h before the request, or by the requester | Explain; wait or use recovery material. |
| 403 | `not_cancellable` | pending action authorized with recovery material, or the caller is the device a revocation targets | Explain; it cannot be cancelled from here. |
| 403 | `stronger_reauth_required` | confirming a pending action with a password grant | Re-authenticate with a passkey or recovery material. |
| 404 | `not_found`, `pairing_not_found` | no such object, or not this account's | Refresh the list; pairing: start again. |
| 404 | `billing_disabled` | billing is off on this server (beta) | Hide "Manage plan". |
| 409 | `generation_mismatch` (+`generation`) | the account rotated meanwhile | Refresh keys (rotation acceptance), rebuild the seal or rotation, retry. |
| 409 | `rotation_pending` | a delayed action is pending; no unlock methods can be added | Show the pending action; cancel, confirm or wait. |
| 409 | `methods_changed` | a rotation lacks a seal for a remaining method | Fetch keys, rebuild the rotation (confirm new methods), retry. |
| 409 | `pairing_cancelled` | the device's method has no pending commitment (a rotation cancelled the pairing) | Pair again. |
| 409 | `already_joined`, `already_approved`, `not_joined` | pairing state conflict | Start a new pairing session. |
| 409 | `exists` | signup for an email that has an account; passkey already registered | Sign in instead; ignore duplicate passkey. |
| 409 | `rotation_required` | deleting a passkey that can unlock | Use the `remove_passkey` rotation. |
| 409 | `head_changed` | re-encryption raced with a write | Skip that head. |
| 409 | `stale_epoch` (+`epoch`) | re-encryption under an old epoch | Refresh keys, retry. |
| 409 | `action_failed` | a confirmed pending action no longer applies (generation changed) | Refresh keys; request it again. |
| 413 | `too_large` | body over the limit | Bug or oversized record: report. |
| 415 | `unsupported_media_type` | not JSON | Bug. |
| 429 | `rate_limited` | per IP, per account or per email limit | Back off with jitter (sync: exponential up to 5 minutes). |
| 500 | `internal` | server error | Retry with backoff; report if persistent. |

Per-write results of `POST /v1/records` (section Records) use `status` values instead of HTTP codes: `accepted`, `conflict`, `exists`, `stale_epoch`, `payment_required`, `rejected`.

## Accounts and signup (ADR 0004)

`POST /v1/signup/start` `{email}` → 202 `{"status":"check_email"}`. Same answer whether or not the email has an account. A new address gets an 8-character Crockford Base32 code (30 minutes, 5 attempts); an existing one gets an "already have an account" mail.

`POST /v1/signup/verify` `{email, code}` → `{signupToken, accountId, serverIdentity, ksfVersion}`. The account id is allocated here so the client can bind keys to it.

`POST /v1/signup/opaque` `{signupToken, registrationRequest}` → `{registrationResponse}`. Credential identifier and client identity are the email.

`POST /v1/signup/finish` →  `{accountId, deviceId, deviceToken}`:

```
{ signupToken, registrationRecord, ksfVersion, accountSalt (16 bytes), expectedGeneration: 1,
  device: { lhDeviceId, name, ephemeral, keysProtected? },
  wraps: [ {name: "ik", wrap}, {name: "vk/1", wrap} ],
  methods: [ method… ] }
method = { kind, publicKey, sealed, commitment, pkTag, authPublicKey? }
```

Exactly one `password`, one `recovery_key`, ten `backup_code` and one `device` method (none when `ephemeral`). `authPublicKey` is required exactly for `recovery_key` and `backup_code`. One transaction.

`GET /v1/account` → `{accountId, email, state, canPush, billingEnabled, trialEndsAt, graceEndsAt, quotaBytes, usedBytes, historyBytes, generation, epoch, lastExportAt, createdAt, backupCodesLeft, passkeys, devices, pendingAction, historyRetentionDays}`.

`DELETE /v1/account` (grant) → `{"status":"deleted"}`. Cancels billing, purges devices, keys, records, history and blobs at once, emails a notice. Other devices get `deleted` on the WebSocket and 401 afterwards.

## OPAQUE sign-in (ADR 0004)

`POST /v1/login/start` `{email, startLoginRequest}` → `{loginId, loginResponse, ksfVersion, serverIdentity}`. Unknown emails get a deterministic fake record, so the answer has the same shape.

`POST /v1/login/finish` `{loginId, finishLoginRequest, device}` → `{accountId, deviceId, deviceToken, newDevice}`. The same `lhDeviceId` reuses its device row (and its `device` method); a new one triggers a new-device notice.

`POST /v1/password/opaque` (token) `{registrationRequest}` → `{registrationResponse, serverIdentity, ksfVersion}`: the first half of a password change; the record goes into the `change_password` rotation.

## Passkeys (ADR 0004)

`POST /v1/passkeys/register/start` (token, grant checked, not consumed) → `{ceremonyId, options, prfSalt}`. `options` are WebAuthn creation options with `extensions.prf.eval.first = prfSalt` and user verification required.

`POST /v1/passkeys/register/finish` (token, grant consumed) `{ceremonyId, credential, name, method?, expectedGeneration}` → `{passkeyId, methodId, signInOnly}`. With `method` (kind `passkey`, from the PRF output) the passkey also unlocks; without it, it is sign-in only. 409 `rotation_pending` while a delayed action waits.

`POST /v1/passkeys/login/start` `{email}` → `{ceremonyId, options}` (fake options for unknown emails). `POST /v1/passkeys/login/finish` `{ceremonyId, credential, device}` → like login finish.

`GET /v1/passkeys` → `{passkeys: [{id, name, signInOnly, createdAt, lastUsedAt, methodId}]}`. `DELETE /v1/passkeys/{id}` (grant) removes a sign-in-only passkey; one with an unlock method is removed by the `remove_passkey` rotation.

Any `credential` whose `clientExtensionResults.prf.results` is present is rejected with 400.

The Android app runs these ceremonies through Credential Manager. Its `clientDataJSON` origin is `android:apk-key-hash:<base64url SHA-256 of the signing certificate>`, accepted for every certificate in `LHV_ANDROID_CERT_SHA256`. `GET /.well-known/assetlinks.json` (no token) lists those apps with the relation `delegate_permission/common.get_login_creds`; Credential Manager reads it from the RP id host before it lets the app use the RP id. Without configured apps it is `[]`.

## Recovery (ADR 0005)

`POST /v1/recovery/start` `{email}` → `{challengeId, accountId, accountSalt, challenge}` (stable fake account id and salt for unknown emails, fresh challenge).

`POST /v1/recovery/finish` `{challengeId, authPublicKey, signature, device}` → `{accountId, deviceId, deviceToken, method, reauthGrant, reauthExpiresAt}`. `method` is the matching `recovery_key` or `backup_code` row (with `sealed` and `commitment`); a backup code's row is deleted in the same transaction. The device opens the root key, then must set a new password with the `change_password` rotation and `reauthGrant` before sync starts.

## Re-authentication (ADR 0013)

All need the device token and return `{grant, strength, expiresAt}`:

- `POST /v1/reauth/password/start` `{startLoginRequest}` → `{loginId, loginResponse, ksfVersion, serverIdentity}`; `.../finish` `{loginId, finishLoginRequest}` → grant, strength `password`.
- `POST /v1/reauth/passkey/start` → `{ceremonyId, options}`; `.../finish` `{ceremonyId, credential}` → grant, strength `passkey`.
- `POST /v1/reauth/recovery/start` → challenge as above; `.../finish` `{challengeId, authPublicKey, signature}` → grant, strength `recovery`, plus `consumedMethodId` when a backup code was used (it is consumed).

Sensitive actions: `POST /v1/rotate`, `POST /v1/passkeys/register/*`, `DELETE /v1/passkeys/{id}`, `DELETE /v1/account`.

## Unlock methods and key wraps (ADR 0002, 0003)

`GET /v1/keys` → `{accountId, generation, epoch, accountSalt, ksfVersion, wraps: [{name, wrap}], methods: [method row], pendingAction, deviceId}` where a method row is `{id, kind, publicKey, sealed, commitment|null, pkTag, authPublicKey?, deviceId, passkeyId, createdAt}`. Wraps are under the current generation.

`POST /v1/methods` (token) `{expectedGeneration, kind: "device", publicKey, sealed, commitment, pkTag}` → `{methodId}`: the calling device's own `device` method after sign-in (replaces an older one). Not for ephemeral devices. 409 `generation_mismatch`, `rotation_pending`.

`PUT /v1/methods/{id}/commitment` (token) `{commitment}`: a paired device uploads the commitment of its own method once. 409 `pairing_cancelled` otherwise.

`DELETE /v1/methods/{id}` (token + grant): removes a `device` unlock method without rotation, for example a row whose `pkTag` does not verify.

## Rotation (ADR 0006)

`POST /v1/rotate` (token + grant):

```
{ expectedGeneration: g, epoch: e + 1,
  wraps: [ ik, vk/1 … vk/(e+1) under ARK_(g+1) ],
  seals: [ {methodId, sealed} for every remaining method ],
  action: { kind: "revoke_device", deviceId }
        | { kind: "change_password", registrationRecord, ksfVersion, methods: [password method] }
        | { kind: "regenerate_recovery_key", methods: [recovery_key method] }
        | { kind: "regenerate_backup_codes", methods: [10 backup_code methods] }
        | { kind: "remove_passkey", passkeyId } }
```

New methods carry their own seal under `g + 1`. One transaction: generation check, action, cancellation of approved pairings without a commitment, re-seal of every remaining method, new methods, wraps replaced, `generation = g + 1`, `current_epoch = e + 1`, pending actions dropped, email notice. Answers `{status: "applied", generation, epoch}`.

`revoke_device`, `regenerate_recovery_key` and `regenerate_backup_codes` with a `password` or `passkey` grant are **delayed**: 202 `{status: "pending", pendingAction}`; the stored request runs after 24 h if the generation still matches. With a `recovery` grant they run at once. One pending action per account.

`POST /v1/pending/{id}/confirm` (token + grant of strength `passkey` or `recovery`): runs it now; only a different device created at least 24 h before the request (403 `not_established`; a password grant gives 403 `stronger_reauth_required`). `POST /v1/pending/{id}/cancel` (token + grant): any device except the one a revocation targets (403 `not_cancellable`), and never for recovery-authorized actions. While an action is pending, any rotation without a `recovery` grant answers 409 `rotation_pending`. `pendingAction = {id, kind, strength, requestedBy, requestedByName, targetDeviceId, runsAt, createdAt, cancellable}`.

## Pairing (ADR 0003)

| Step | Request | Answer |
| --- | --- | --- |
| Signed-in device shows | `POST /v1/pairing` (token) `{shownBy: "approver"}` | `{pairingId, expiresAt}` |
| New device shows | `POST /v1/pairing` `{shownBy: "joiner"}` | `{pairingId, joinerToken, expiresAt}` |
| New device joins | `POST /v1/pairing/{id}/join` `{publicKey, joinTag, device}` (+ `LHV-Pairing-Token` if it showed) | `{state: "joined", joinerToken?}` |
| Signed-in device reads | `GET /v1/pairing/{id}` (token; binds a joiner-shown session to the account) | `{state, expiresAt, join?: {publicKey, joinTag, name, lhDeviceId, ephemeral}}` |
| Signed-in device approves | `POST /v1/pairing/{id}/approve` (token) `{sealed, approveTag, pkTag, expectedGeneration}` | `{state: "approved"}` |
| New device collects | `GET /v1/pairing/{id}` (`LHV-Pairing-Token`) | `{state, approval?: {accountId, deviceId, methodId, deviceTokenSealed, sealed, approveTag, generation}}`, delivered once, then the session is deleted; `deviceTokenSealed` is `crypto_box_seal(token, joinPublicKey)`, so the token is never stored in plaintext |
| Either cancels | `DELETE /v1/pairing/{id}` | `{state: "cancelled"}` |

A session accepts one join and expires after 10 minutes. Approval creates the device, its token and (unless ephemeral) its `device` method without a commitment; the method becomes usable after `PUT /v1/methods/{id}/commitment`.

## Devices

`GET /v1/devices` → `{devices: [{id, lhDeviceId, name, ephemeral, keysProtected, createdAt, lastSeenAt, current, established, hasUnlockMethod}]}`. `PATCH /v1/devices/{id}` `{name}`. `POST /v1/devices/self/signout`: deletes the calling device, its token and its `device` method, without rotation. Revoking another device is the `revoke_device` rotation.

## Records and changes (ADR 0007, 0008, 0009)

`POST /v1/records` (token), `multipart/form-data`: first part `writes` (JSON `{writes: [write…]}`), then one part `blob` per write in the same order.

```
write = { recordId, kind: "doc" | "seg", baseSeq (documents only; 0 for new), epoch, tombstone, sha256, size }
```

1 to 100 writes, at most 64 MiB. A tombstone envelope is at most 4 KiB (it is free of quota). Each write is its own transaction; the answer is `{results: [result…], lastSeq}` with one result per write:

| `status` | Fields | Meaning | Client reaction |
| --- | --- | --- | --- |
| `accepted` | `seq` | new version | Record the seq; drop the outbox entry. |
| `conflict` | `headSeq` | `baseSeq` is not the head | ADR 0008: fetch the head, keep the local version as a conflict version (unless the head is this device's own write lost by a crash, or equal to the local content). |
| `exists` | `sha256` | segment already stored | Accepted if the stored segment decrypts to the same bytes; otherwise report and stop that ledger. |
| `stale_epoch` | `generation`, `epoch` | write under an old epoch | Accept the new generation (rotation acceptance), re-encrypt, push again. |
| `payment_required` | `error`, `message` | quota or account state | Status over quota / read-only; keep the outbox. Tombstones are always accepted and free space. |
| `rejected` | `error`, `message` | `hash_mismatch`, `too_large`, `kind_mismatch`, `bad_request` | Report; keep the entry. |

The server checks the blob's SHA-256 and size and that the envelope's version byte and epoch match the declared epoch. A blob is durable on disk before its row commits.

`GET /v1/changes?since=<seq>&limit=<n ≤ 1000>` → `{changes: [change…], cursor, more, lastSeq, generation, epoch}`, heads changed after `since` in seq order; continue with `since = cursor` while `more`. `change = {recordId, kind, seq, epoch, size, sha256, tombstone, deviceId, deviceName, createdAt}`. A `generation` above the device's own means a rotation happened.

`GET /v1/blobs/{sha256}` (token) → the envelope (`application/octet-stream`, `Content-Length`), only if a record of the account references it.

## Events

`GET /v1/events` (token): WebSocket. Text messages:

- `{"type":"hello","seq","generation","epoch"}` on connect;
- `{"type":"change","seq"}` after accepted writes;
- `{"type":"keys","generation","epoch"}` after a rotation;
- `{"type":"devices"}`, `{"type":"pending"}` when the device list or a pending action changes;
- `{"type":"revoked"}` to the revoked device, `{"type":"deleted"}` after account deletion; the server then closes the connection.

The server pings every 30 s. Notices may be dropped; devices also pull every 60 s.

## Re-encryption (ADR 0006 step 7)

`POST /v1/reencrypt/claim` (token) → `{heads: [change…], leaseSeconds: 600}`: up to 100 heads with an older epoch, leased to the device.

`POST /v1/reencrypt` (token), multipart: part `meta` `{recordId, seq, oldSha256, epoch (current), sha256, size}`, part `blob`. Swaps the head's blob if it is still `seq` with `oldSha256` → `{status: "swapped"}`; otherwise 409 `head_changed`. No new version.

## History (ADR 0010)

`GET /v1/history?at=<RFC 3339>` → `{at, records: [change…], retentionDays: 90}`: the versions that were heads at that time (tombstones included). `GET /v1/history/{recordId}` → `{recordId, versions: [change…]}` newest first. Superseded versions are kept 90 days, capped at the quota.

## Export (ADR 0010)

`GET /v1/export` (token) → `lhv-export-<yyyymmdd>.tar` (`application/x-tar`, streamed): `manifest.json` then `blobs/<sha256>` (spec section 9). Records the export time (`lastExportAt`) for the 90-day reminder.

## Billing (ADR 0011)

`POST /v1/billing/link` (token) → `{url}`: a one-time link to the account pages, valid 5 minutes. 404 `billing_disabled` in the beta.

`POST /v1/billing/webhook` (form `id=tr_…|sub_…`, from Mollie): the server fetches the resource from Mollie and applies it idempotently. 200 for known and unknown ids, 400 for a missing id, 500 on transient errors so Mollie retries.

Account pages (server-rendered, no JavaScript, strict cookies, CSRF tokens): `GET /account/session?token=` (exchanges the link for a 30-minute session), `GET /account`, `GET|POST /account/plan`, `GET /account/return`, `GET|POST /account/cancel`, `POST /account/logout`, `GET /account/invoices/<number>.pdf`, and public `/imprint`, `/privacy`, `/terms`.
