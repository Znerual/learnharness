# Plugin data sync: implementation plan

Status: implemented on `main` (2026-11-18), not released; see "Implementation status" at the end. Design: [ADR 0007](adr/0007-plugin-data-syncs-without-plugin-changes.md) in this repo and learnharness-vault ADR 0014 (delta chains). Work spans this repo (the app and `packages/vault-client`) and learnharness-vault (server, spec, vectors, `lhv-decrypt`).

The phases are ordered by dependency, but all of them ship in one release (owner, 2026-11-18): the next app release, which carries vault client 0.5.0 (`packages/vault-client`; the app itself is 0.6.x), with the server. Each device syncs plugin data as soon as it runs that release. A device whose vault client is 0.3.0 or older cannot read the version-2 slot records and stops syncing once any device writes plugin data, until it updates. Phases 4 and 5 stay in the fork (owner, 2026-11-18).

## Phase 0: compatibility release

Goal: clients ignore record paths they do not know, and every device reports what it supports.

Client (`packages/vault-client`, version 0.4.0):

- `src/sync/engine.ts` `applyChange`: a document whose path is not a known document path is skipped and counted (`status.skipped`), without setting an error. Malformed segments still go through `reject`.
- After sign-in and at every engine `init`, the device sends its capabilities with `PATCH /v1/devices/self` `{capabilities: ["skip-unknown-1"]}`.
- Tests: an engine test that a `pf/...` document is skipped without an error; the existing vector and mapping tests stay green.
- Settings → Vault lists devices that report no capabilities (older than phase 0); they show sync errors for plugin records until they update.

Server (learnharness-vault):

- Migration `internal/db/migrations/00003_device_capabilities.sql`: `devices.capabilities text[] NOT NULL DEFAULT '{}'`.
- `PATCH /v1/devices/self` `{capabilities}` (at most 16 entries, each `^[a-z0-9-]{1,32}$`); `GET /v1/devices` returns `capabilities`. Update `docs/protocol/api.md`.
- Tests in `internal/server` for validation and the listing.

Done when: a current device and a phase-0 device sync normally while a third test client writes `pf/` records, and the phase-0 device shows no error.

## Phase 1: delta format and chain header

Goal: the byte format of ADR 0014, in both implementations, with vectors. One commit per spec rule (spec section 10).

- Client `src/sync/delta.ts`: `encodeDelta(base, next)` (rolling hash over 64-byte blocks, emits COPY/INSERT) and `applyDelta(base, ops, {maxSize, maxOps: 65536})`, refusing COPY ranges outside `base`, results over `maxSize` and a SHA-256 mismatch.
- Client `src/crypto/envelope.ts`: the optional `chain` header field `{type, size, sha256, baseSha256}`, strictly typed when present.
- Go `internal/protocol/record.go` and a new `delta.go`: the same header field and `ApplyDelta` (the server never applies deltas; `lhv-decrypt` does).
- Spec `docs/protocol/spec.md` section 8: the `chain` field, the operation framing, the reader's refusal rules.
- Vectors `docs/protocol/vectors/record.json`, copied to `packages/vault-client/test/vectors/`: a full slot, a delta slot, an append-only delta, and refused deltas (COPY out of range, too many operations, size over the limit, wrong result hash).
- Tests: vectors in both languages; a property test that `applyDelta(base, encodeDelta(base, next))` equals `next` for random and JSON-shaped inputs; size of the delta for a Flashcards-like rating is under 2 KB.

## Phase 2: chain engine in the vault client

Goal: plugin files sync as delta chains, generic over any file set the host offers.

- `src/sync/chains.ts`:
  - record paths `pr/<slot>`, `pi/<origin>/<id>/<slot>`, `pf/<origin>/<id>/<rel>/<slot>`; path validation as in ADR 0007 (segments, depth, extensions);
  - device-local state under `local/vault/chains/`: shadows (last synced bytes per file), the record-id map (record id to chain and slot), parked changes, and per-chain heads;
  - the writer: delta or full slot by the 50 % / 100-delta rule, create-only writes, then the index slot, then the registry slot for a new plugin;
  - 409 on a file slot: pull, merge three ways (`src/sync/merge.ts`, below) with the shadow as the common ancestor, write the result to the next slot; 409 on an index slot: pull the index and write on top of it; change against a deleted file: full slot at the next free number;
  - the reader: registry and indexes always downloaded; a change for an inactive plugin skipped without download; an unknown record id parked, resolved by a later index, downloaded once after 24 h;
  - activation backfill: newest full slot plus later deltas for each file of the plugin's index;
  - the daily sweep that tombstones slots before the newest full slot once they are older than 90 days;
  - "delete synced data": tombstones every slot of the plugin and removes it from the registry.
- `src/sync/merge.ts`: `merge3(base, local, remote, kind)` for JSON (objects by key, `id`-keyed arrays as sets, other arrays element by element, edit wins over delete, same value changed on both sides takes the remote value and reports the local one), text (line merge, overlaps reported) and images (remote). Returns the merged bytes and the list of conflicts for the conflict copy. Deterministic: the same inputs give the same bytes on every device.
- `src/sync/engine.ts`: a new outbox entry type `{t: "chain", p: <file>}`; the pull routes `pr/`, `pi/` and `pf/` changes to `chains.ts`; the device reports `chains-1` with its capabilities.
- `src/sync/host.ts`: a `PluginFilesHost` interface: list active plugins with origin, id, identity and limits; read and list files; `applyPluginFiles(plugin, writes, deletes)` as one batch (the host stops and restarts the plugin around it); `writePluginConflict`; `removePluginLocalData`. `FsHost` gets a plain implementation for tests.
- Tests for `merge.ts`: table tests for every rule; real Flashcards files edited on two copies (different decks renamed, cards added on both, one card edited on both, deck deleted on one and changed on the other); merging twice gives the same bytes.
- Tests (fake server and the real-server e2e of `tests/vault-sync-e2e.test.ts`): two devices edit different parts of one file (both changes kept); two devices change the same value (vault's value kept, conflict copy written); appends from two installs in different files (no conflict); compaction after 100 deltas; a device far behind jumps to the full slot; a missing slot waits; a corrupt delta falls back to the full slot; a plugin installed later receives all data; an inactive plugin's records are never downloaded; limits refuse oversized files on both sides; the sweep tombstones only slots before a full slot older than 90 days.

## Phase 3: LearnHarness host

Goal: the app side of ADR 0007.

- `src/server/vault/plugin-sync.ts` (new):
  - activeness: installed and enabled (from the plugin host) and, for community plugins, sync turned on in the device-local `local/vault/plugin-sync.json` (not `plugins-state.json`, which stays upstream's);
  - the scanner: size and mtime, then SHA-256; skips dotfiles, `*.tmp`, symlinks, extensions outside the allow list, the manifest's `sync.exclude`; enforces the per-file, per-plugin and file-count limits; runs after each plugin bridge call, after each worker finishes, every 60 s and at shutdown;
  - removal handling: a community plugin whose folder disappeared (manual uninstall) or whose sync was turned off is marked inactive; its shadows, map entries and `ctx.localDataDirectory` are removed; no tombstones are written.
- `src/server/plugin-host.ts`:
  - track in-flight `call()` operations per plugin;
  - `quiesce(id, apply)`: enqueue; wait until no call is in flight and no worker task of the plugin is live; `deactivate`; run `apply`; `activate`; emit a plugin refresh event so open views remount;
  - merge fallback: if activation fails after applying a merged file, write the vault's version, keep the local version as a conflict copy, and activate again;
  - before `activate` after enable, install or sync opt-in, await the activation backfill from the chain engine.
- `src/server/vault/host.ts`: implement `PluginFilesHost` over `safePluginDataDirectory`, with the write rules of ADR 0007 (no symlink on the path, exclusive temporary file, rename, JSON and UTF-8 checks).
- Manifest: optional `sync.exclude` (array of relative patterns, at most 32), validated where manifests are validated; unknown to upstream builds, which must ignore it (check before the upstream PR in phase 4).
- Settings → Vault (`components/vault/`): plugin sync section with a per-community-plugin toggle, the identity-mismatch prompt, over-limit status, plugin conflict copies, devices that do not receive plugin data yet because they need an update, and "Delete synced data" with confirmation and re-authentication (vault ADR 0013).
- Tests: `tests/plugin-sync-scanner.test.ts` (exclusions, limits, symlinks), `tests/plugin-sync-apply.test.ts` (path traversal, symlinked directories, nothing reaches `dist/`, JSON refused when invalid, a merged file the plugin refuses is replaced by the vault's version), `tests/plugin-sync-quiesce.test.ts` (waits for a running worker, backend restarted, views refreshed), `tests/plugin-sync-activation.test.ts` (disabled core plugin receives nothing; enabling backfills before the backend starts; uninstall writes no tombstones; reinstall restores everything), and an e2e extension of `tests/vault-sync-e2e.test.ts`: Flashcards data made on device A appears on device B after B enables Flashcards.

## Phase 4: `ctx.localDataDirectory` (upstream API)

- `src/core/plugins.ts` `PluginBackendContext`: `localDataDirectory: string`.
- `src/server/plugin-host.ts`: create it at activation through the same safe resolver, under `LH_LOCAL_DIR/plugin-local/<id>/` in the fork; upstream, a sibling of the data folder.
- Authoring types (`scripts/build-plugin-types.mjs`), `docs/plugin-authoring.md`, `tests/plugin-api-reference.test.ts`.
- Coding Questions manifest: `sync.exclude: ["test-runs/"]`. The fork carries it until upstream takes it (owner, 2026-11-18).
- Fork only (owner, 2026-11-18): no upstream PR for now.

## Phase 5: Flashcards (upstream PR)

- Install id in `ctx.localDataDirectory/install.json`.
- Reviews appended to `reviews/<installId>.jsonl`; schedules rebuilt by replaying all installs' reviews in time order.
- One-time migration of `reviews[]` from `flashcards.json` into this install's file. Two devices that both had the same old file (Syncthing era) would migrate the same reviews: the replay deduplicates by review id.
- `modelOverride` moves to `ctx.localDataDirectory/settings.json`.
- Replay uses the current settings. The daily new-card limit counts the reviews of every install (owner, 2026-11-18).
- Tests in `plugins/flashcards/tests/`: replay equals the old stored schedule for existing data with unchanged settings; two installs' reviews merge; the daily limit counts both installs; migration is idempotent.
- Fork only (owner, 2026-11-18): no upstream PR for now.

## Phase 6: export

- `tools/lhv-decrypt` and `internal/protocol/export.go`: rebuild each plugin file from its newest full slot and the deltas after it; skip registry and index chains.
- Core plugin data to `core-plugin-data/<id>/<rel>`; community plugin data to `plugin-data/community/<id>/<rel>`, with a note in the README of `lhv-decrypt` on where to copy it (owner, 2026-11-18).
- Spec section 9 and `vectors/export.json` gain a plugin file with one full slot and two deltas.

## Release order

One release (owner, 2026-11-18), on the owner's go:

1. Deploy the server. It still accepts version-1 records and the old endpoints, so clients on 0.3.0 keep syncing.
2. Publish the app release with vault client 0.5.0 (desktop and Android) and update every device. A device left on vault client 0.3.0 or older stops syncing as soon as an updated device writes plugin data; Settings → Vault → Plugin data names it.
3. Phases 4 and 5 stay in the fork; no upstream PR.

Deploying stays with the owner; no phase deploys or pushes by itself.

## Decisions (owner, 2026-11-18)

1. Community plugin data in the export: `plugin-data/community/<id>/`.
2. No account-wide gate: a device without delta-chain support gets no plugin data until it updates; the others sync.
3. Coding Questions `sync.exclude` is carried in the fork until upstream takes it.
4. Flashcards replay uses the current settings; the daily new-card limit is per learner across devices.
5. Concurrent changes merge three ways, JSON-aware, on the delta chains; not git, not Automerge.

## Implementation status (2026-11-18)

| Phase | Commits | Tests |
| --- | --- | --- |
| 0 compatibility | learnharness `e98acb5`, vault `1fdd696` | Go `TestDeviceCapabilities`, e2e security test |
| 1 delta format | learnharness `eaba5bf`, vault `c7c24f6` | `packages/vault-client/test/delta.test.ts`, vectors in both languages |
| 2 chain engine | learnharness `c7819c6`, vault `531d149` | `test/merge.test.ts`, vault `e2e/plugins.e2e.test.ts` (9 cases against the server) |
| 3 app host | learnharness `eaa086d` | `tests/plugin-sync.test.ts` |
| 4 `ctx.localDataDirectory` | learnharness `013c5d2` | `tests/plugin-sync.test.ts` |
| 5 Flashcards | learnharness `70a9695` | `plugins/flashcards/tests` (store and backend) |
| 6 export | vault `c7c24f6` | Go export vectors, `lhv-decrypt` tests |
| Owner decisions: envelope version 2, re-authenticated deletion, slot numbering after tombstones | learnharness `3219116`, vault `c52e3be` | record and export vectors (version 2 cases), Go `TestReauthConsume`, `tests/vault-routes.test.ts` (plugin data deletion), vault `e2e/plugins.e2e.test.ts` (deletion with a grant, recreated file) |

Owner decisions after the first implementation (2026-11-18), done:

- Delta-chain slots are a new spec version: envelope version `0x02` with the label `lhv2/rec/`, export manifest version 2 (spec sections 8 to 10, vectors). Clients skip envelope versions they do not know.
- "Delete data in the vault" needs re-authentication; the grant is spent with the new `POST /v1/reauth/consume`, which emails a notice.
- One release: devices on clients up to 0.3.0 stop syncing until they update (accepted).
- `ctx.localDataDirectory` and the Flashcards change stay in the fork; no upstream PR.

Not done:

- No end-to-end test runs two app processes with Flashcards against a real vault; the engine is tested end to end with a test plugin host, and the app side with unit tests.
- Plugin sync status reaches the UI through Settings → Vault → Plugin data only; the sync status banner does not mention plugins.
- Nothing is pushed, released or deployed.
