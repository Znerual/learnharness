# Plugin data sync: implementation plan

Status: plan (2026-11-18). Design: [ADR 0007](adr/0007-plugin-data-syncs-without-plugin-changes.md) in this repo and learnharness-vault ADR 0014 (delta chains). Work spans this repo (the app and `packages/vault-client`) and learnharness-vault (server, spec, vectors, `lhv-decrypt`).

The phases are ordered by dependency. Phase 0 ships alone, before everything else, because today's client reports every unknown record path as an error. Phases 1 to 3 and 6 ship together in one release; plugin sync stays off on an account until every device supports it. Phases 4 and 5 are upstream changes and need an explicit go before any PR.

## Phase 0: compatibility release

Goal: clients ignore record paths they do not know, and every device reports what it supports.

Client (`packages/vault-client`, version 0.4.0):

- `src/sync/engine.ts` `applyChange`: a document whose path is not a known document path is skipped and counted (`status.skipped`), without setting an error. Malformed segments still go through `reject`.
- After sign-in and at every engine `init`, the device sends its capabilities with `PATCH /v1/devices/self` `{capabilities: ["skip-unknown-1"]}`.
- Tests: an engine test that a `pf/...` document is skipped without an error; the existing vector and mapping tests stay green.

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
  - 409 on a file slot: pull, keep the vault's version, hand the local version to the host as a conflict; 409 on an index slot: pull the index and write on top of it; change against a deleted file: full slot at the next free number;
  - the reader: registry and indexes always downloaded; a change for an inactive plugin skipped without download; an unknown record id parked, resolved by a later index, downloaded once after 24 h;
  - activation backfill: newest full slot plus later deltas for each file of the plugin's index;
  - the daily sweep that tombstones slots before the newest full slot once they are older than 90 days;
  - "delete synced data": tombstones every slot of the plugin and removes it from the registry.
- `src/sync/engine.ts`: a new outbox entry type `{t: "chain", p: <file>}`, the pull routes `pr/`, `pi/` and `pf/` changes to `chains.ts`, and the chain feature turns on only when `GET /v1/devices` shows `chains-1` on every device (the device then reports `chains-1` itself).
- `src/sync/host.ts`: a `PluginFilesHost` interface: list active plugins with origin, id, identity and limits; read and list files; `applyPluginFiles(plugin, writes, deletes)` as one batch (the host stops and restarts the plugin around it); `writePluginConflict`; `removePluginLocalData`. `FsHost` gets a plain implementation for tests.
- Tests (fake server and the real-server e2e of `tests/vault-sync-e2e.test.ts`): two devices edit one file (one conflict, vault wins); appends from two installs in different files (no conflict); compaction after 100 deltas; a device far behind jumps to the full slot; a missing slot waits; a corrupt delta falls back to the full slot; a plugin installed later receives all data; an inactive plugin's records are never downloaded; limits refuse oversized files on both sides; the sweep tombstones only slots before a full slot older than 90 days.

## Phase 3: LearnHarness host

Goal: the app side of ADR 0007.

- `src/server/vault/plugin-sync.ts` (new):
  - activeness: installed and enabled (from the plugin host) and, for community plugins, sync turned on in the device-local `local/vault/plugin-sync.json` (not `plugins-state.json`, which stays upstream's);
  - the scanner: size and mtime, then SHA-256; skips dotfiles, `*.tmp`, symlinks, extensions outside the allow list, the manifest's `sync.exclude`; enforces the per-file, per-plugin and file-count limits; runs after each plugin bridge call, after each worker finishes, every 60 s and at shutdown;
  - removal handling: a community plugin whose folder disappeared (manual uninstall) or whose sync was turned off is marked inactive; its shadows, map entries and `ctx.localDataDirectory` are removed; no tombstones are written.
- `src/server/plugin-host.ts`:
  - track in-flight `call()` operations per plugin;
  - `quiesce(id, apply)`: enqueue; wait until no call is in flight and no worker task of the plugin is live; `deactivate`; run `apply`; `activate`; emit a plugin refresh event so open views remount;
  - before `activate` after enable, install or sync opt-in, await the activation backfill from the chain engine.
- `src/server/vault/host.ts`: implement `PluginFilesHost` over `safePluginDataDirectory`, with the write rules of ADR 0007 (no symlink on the path, exclusive temporary file, rename, JSON and UTF-8 checks).
- Manifest: optional `sync.exclude` (array of relative patterns, at most 32), validated where manifests are validated; unknown to upstream builds, which must ignore it (check before the upstream PR in phase 4).
- Settings → Vault (`components/vault/`): plugin sync section with a per-community-plugin toggle, the identity-mismatch prompt, over-limit status, plugin conflicts, devices that block plugin sync because they need an update, and "Delete synced data" with confirmation and re-authentication (vault ADR 0013).
- Tests: `tests/plugin-sync-scanner.test.ts` (exclusions, limits, symlinks), `tests/plugin-sync-apply.test.ts` (path traversal, symlinked directories, nothing reaches `dist/`, JSON refused when invalid), `tests/plugin-sync-quiesce.test.ts` (waits for a running worker, backend restarted, views refreshed), `tests/plugin-sync-activation.test.ts` (disabled core plugin receives nothing; enabling backfills before the backend starts; uninstall writes no tombstones; reinstall restores everything), and an e2e extension of `tests/vault-sync-e2e.test.ts`: Flashcards data made on device A appears on device B after B enables Flashcards.

## Phase 4: `ctx.localDataDirectory` (upstream API)

- `src/core/plugins.ts` `PluginBackendContext`: `localDataDirectory: string`.
- `src/server/plugin-host.ts`: create it at activation through the same safe resolver, under `LH_LOCAL_DIR/plugin-local/<id>/` in the fork; upstream, a sibling of the data folder.
- Authoring types (`scripts/build-plugin-types.mjs`), `docs/plugin-authoring.md`, `tests/plugin-api-reference.test.ts`.
- Coding Questions manifest: `sync.exclude: ["test-runs/"]`.
- Upstream PR only after an explicit go.

## Phase 5: Flashcards (upstream PR)

- Install id in `ctx.localDataDirectory/install.json`.
- Reviews appended to `reviews/<installId>.jsonl`; schedules rebuilt by replaying all installs' reviews in time order.
- One-time migration of `reviews[]` from `flashcards.json` into this install's file. Two devices that both had the same old file (Syncthing era) would migrate the same reviews: the replay deduplicates by review id.
- `modelOverride` moves to `ctx.localDataDirectory/settings.json`.
- Tests in `plugins/flashcards/tests/`: replay equals the old stored schedule for existing data; two installs' reviews merge; migration is idempotent.
- Blocked by owner decisions: replay with settings changed between reviews, and daily new-card limits across installs.
- Upstream PR only after an explicit go.

## Phase 6: export

- `tools/lhv-decrypt` and `internal/protocol/export.go`: rebuild each plugin file from its newest full slot and the deltas after it; skip registry and index chains.
- Core plugin data to `core-plugin-data/<id>/<rel>`; community plugin data: blocked by the owner decision on its export location.
- Spec section 9 and `vectors/export.json` gain a plugin file with one full slot and two deltas.

## Release order

1. Phase 0: vault release and fork release. All devices update.
2. Phases 1, 2, 3 and 6 in one release. Plugin sync turns on per account once every device reports `chains-1`.
3. Phases 4 and 5 after the owner's go for the upstream PRs; the fork carries them until upstream merges.

Deploying stays with the owner; no phase deploys or pushes by itself.

## Open decisions

1. Where `lhv-decrypt` writes community plugin data (phase 6).
2. A device that never updates blocks plugin sync for the whole account. Proposed: show it in Settings → Vault; the learner updates or revokes it.
3. Coding Questions `sync.exclude` lives in an upstream plugin's manifest: carry it in the fork until upstream takes it (phase 4).
4. Flashcards replay rules (phase 5).
