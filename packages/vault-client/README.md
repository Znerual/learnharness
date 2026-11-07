# @znerual/learnharness-vault-client

The LearnHarness Vault client package: crypto, protocol, account flows, sync engine and outbox (ADR 0001). It runs in the LearnHarness server process (Node under Electron, and Node 18 under `nodejs-mobile` on Android). The renderer and WebView never hold keys.

## Where it lives

This package is part of the learnharness repository (`packages/vault-client/`), under the repository's license (AGPL-3.0-only). The app imports it from source: `@znerual/learnharness-vault-client` resolves to `src/index.ts` through the `paths` entry in the root `tsconfig.json` (honoured by `tsx` and by Next's bundler), so there is no build step and no separate install. Its runtime dependencies (`libsodium-wrappers`, `@serenity-kit/opaque`, `ws`) are dependencies of the root `package.json`.

The vault server (a separate service) is not part of this repository. The protocol the client speaks is documented here: `docs/api.md` (HTTP API) and `docs/spec.md` (byte formats); `test/vectors/` holds the test vectors both sides check against.

The WebAssembly of `libsodium-wrappers` and `@serenity-kit/opaque` is embedded in their JavaScript, so the package loads offline and from inside an Electron asar or the `nodejs-mobile` project without extra files.

## Use

- `Vault`: signup, sign-in, unlock (`Vault.open` on launch), recovery, re-authentication, rotations, devices, pairing, passkeys, export, deletion. Secrets go through a `KeyStorage` adapter that the host provides (Electron `safeStorage` bridge, Android Keystore bridge).
- `SyncEngine` with a `SyncHost` adapter over the LearnHarness store; the host must call `noteDocumentChanged(path)` before it writes a document (intent first) and `noteLedgerAppended(file, offset)` before it appends to a ledger.
- `Restorer`: version lists and point-in-time restore.

The HTTP API is in `docs/api.md`, the byte formats in `docs/spec.md`.

### Pairing: show whose vault is being joined

In joiner-shown pairing (the new device shows the QR code) anyone who photographed the code can approve the join from their own account. After `JoinerPairing.finish()` the returned vault has `vault.accountEmail`. The UI must show "Joining the vault of <email>" and let the learner cancel (`vault.signOut()`) before the sync engine starts. Do not start sync on a freshly paired vault until the learner confirmed the email.

### Rotations and new methods

Pass `confirmNewMethods` in `VaultOptions`; without it a rotation that would seal to an unpinned method fails with `methods_not_confirmed`. `vault.unverifiedMethods` lists server rows that failed verification or are consumed backup codes; remove them with `vault.removeMethod(id, grant)`.

## Versioning

`clientVersion` (in `src/index.ts`) and `package.json` carry the same version; `CHANGELOG.md` records the changes. The vault server's protocol checks are what decide compatibility, not the package version.

## Development

From the repository root, `npm test` includes this package's unit and vector tests and `npm run typecheck` checks it with its own stricter `tsconfig.json`. Inside this folder: `npx tsx --test test/*.test.ts`, and `npx tsx scripts/gen-vectors.ts` to regenerate the vectors (deterministic; copy them to the vault server's checkout when they change). The end-to-end tests against a running vault server stay with the server.
