# Changelog

All notable changes of `@znerual/learnharness-vault-client`. Versions follow semver; see "Versioning" in `README.md`.

## Hardening (unreleased, after 0.5.0)

The server and the other devices of an account are not trusted to send sane data (vault findings H-017 to H-020).

- API client: redirects are refused; answers are read with a size limit (blobs 32 MiB plus overhead, JSON 128 MiB, error bodies 64 KiB) and a time limit (2 minutes for JSON, 20 minutes for uploads and blob downloads); a blob hash from the server must be a SHA-256 before it goes into a URL.
- Pull: a page of changes must move the cursor forward (`checkChangesPage`); a record that does not decrypt or is malformed is refused and counted in `SyncStatus.rejected` instead of stopping every later pull. Network and disk failures still stop the pull.
- Documents: a path syncs only when every name in it can be created on every system (`isPortableName`: no control characters, no characters Windows forbids, no Windows device name, no leading dot, no trailing dot or space, at most 200 bytes).
- Plugin sync: registry and index entries from other devices are validated (`parseRegistry`, `parseIndex`): at most 1,000 plugins, 10,000 files per plugin and 10,000 slots between a file's full slot and its head.
- Plugin sync, receiving: a slot from another device is kept only within the plugin's limits (file size, number of files), when this device's own exclusion rules accept the file (`PluginFilesHost.acceptsPluginFile`), and while fewer than 1,000 slots of that file (20,000 in all) wait for their predecessors (vault finding H-021).
- Merge: bounded memory for the sequence matcher (64 MiB), arrays merge by id up to 5,000 elements, JSON nesting up to 64 levels; beyond that the remote version is taken and the file is reported as a conflict. A key named `__proto__` stays a key.

## 0.3.0 (unreleased)

- `SyncEngine.documentState(path)`: "live", "deleted" or "unknown" for a document, from the authenticated heads this device has synced. Lets a merge of old local data skip documents deleted in the vault.
- base64url works in browsers (`btoa`/`atob` when Node's `Buffer` is missing), for the signup website.

## 0.2.0

Security review fixes. Breaking: needs a server with the matching pairing and pending-action changes.

- Breaking: `joinTag` now also covers the joiner's LearnHarness device id and ephemeral flag (spec section 7); `joinTag`/`verifyJoinTag` take two more arguments. Old and new devices cannot pair across this change.
- Breaking: the pairing approval carries `deviceTokenSealed` (sealed box to the joiner's device key) instead of `deviceToken`. `JoinerPairing.finish` opens it, fetches `/v1/account` and sets `vault.accountEmail`; the UI must show "Joining the vault of <email>" and offer cancel (see README).
- Breaking: `confirmPending(id, grant)` and `cancelPending(id, grant)` need a re-authentication grant.
- Breaking: a missing `confirmNewMethods` callback now fails closed (`methods_not_confirmed`) when a rotation would seal to a method this device has not pinned.
- Pins are persisted in the key bundle (bundle version 2; v1 bundles load with no pins), so rule 5 survives restarts.
- Backup codes seen consumed are remembered; a server that keeps listing one gets `server_kept_consumed_method` and the row is never pinned or sealed to.
- `pinAll` skips and records methods that fail verification (`vault.unverifiedMethods`); sign-in and recovery no longer fail because of one bad row. Rotations throw `unverified_methods` naming them; `vault.removeMethod(id, grant)` deletes a row.
- A fresh unlock on a device that already holds keys for the account must open the same IK and vault keys (`rotation_rejected` otherwise).
- Sync and restore take deletion only from the authenticated record header, and skip (report) records with a non-document or malformed path (`SyncStatus.rejected`, `Restorer.skipped`).
- Passwords are normalized to NFC before OPAQUE (signup, sign-in, reauth, password change). Beta accounts created with a non-NFC non-ASCII password still sign in and re-authenticate: NFC is tried first, then the raw string.
- Sync: a pending outbox entry blocks a remote update only when the local file differs from the known head (re-checked right before writing); `seedAll` skips files already equal to the known head; a multi-segment ledger push keeps its outbox entry until the last segment is accepted; the WebSocket stops reconnecting after revoked, needs_unlock, rotation_rejected or a 401 upgrade.
- Recovery text may contain any whitespace (matches Go `ParseRecoveryText`).
- `UnprotectedFileKeyStorage` and `Vault` serialize saves; each write uses a unique temp file.
- Record paths starting with `lhv1/` are reserved and rejected (protocol spec section 8).

## 0.1.0 (2026-11-01)

First beta. Requires a vault server that speaks API `/v1` and protocol `lhv1` (any server built from this repo at or after the same commit).

- Crypto core: key hierarchy, wraps, record envelopes, unlock methods, commitments, pkTag, rotation acceptance, recovery key and backup codes, pairing tags (`docs/protocol/spec.md`, shared test vectors).
- Account flows (`Vault`): signup with email code, OPAQUE sign-in, unlock on launch, recovery sign-in, re-authentication, rotations, devices, pairing in both directions, passkeys with and without PRF, export download, account deletion, `leaveVault`.
- Sync engine (`SyncEngine`): outbox, push, pull, segments, conflict versions (ADR 0008), stale epochs, background re-encryption, WebSocket and poll triggers, status for the UI.
- Point-in-time restore (`Restorer`).
- `KeyStorage` port with `MemoryKeyStorage` (session mode) and `UnprotectedFileKeyStorage` (explicit opt-in).
