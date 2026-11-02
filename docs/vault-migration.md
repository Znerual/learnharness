# Moving a LearnHarness data folder into a vault account

Status: implemented on `vault-migration` (fork only, private). Code: `src/server/migration/` (`upgrade.ts`, `syncthing.ts`, `merge.ts`), wired in `src/server/vault/runtime.ts`; screens: `components/vault/Migration.tsx`, `components/vault/Join.tsx`. Tests: `tests/migration-*.test.ts(x)`, fixtures in `tests/fixtures/migration/`.

## What the old formats are

Read from git history (`git log` of `src/store/`, `config.ts`, `src/core/contracts/`) and confirmed by writing real folders with each release's own store code (see "Fixtures").

| Source | Data folder layout | Stamps |
| --- | --- | --- |
| Upstream 0.3.0 to 0.4.1, and fork builds up to `v0.3.6001` ("layout 1") | One folder. `chats/<id>.json`, `jobs/<id>.json`, `prompts/*.md`, `graph/{nodes,chains,sessions,coverage}.jsonl` written by every device (shared files), `graph/sources.json`. **Device-local records live inside it:** `settings.json` (with the prompt switches under `agent.prompts`), `graph/positions.json`, `graph/render-settings.json`, `debug/`. No device identity. | chat 1, settings 1, graph format 1 (`graph/format.json`, created by the first graph write) |
| Fork from `v0.3.8001` to `v0.4.2001`, and `vault-integration` ("layout 2", multi-device, ADR 0002 and 0003) | Synced folder holds only synced records. Device-local records are in the local folder (`LH_LOCAL_DIR`): `settings.json`, `positions.json`, `render-settings.json`, `device.json`, `debug/`. Prompt switches are `prompts/switches.json`. Each device writes its own ledgers `graph/<ledger>.<deviceId>.jsonl` (plus `deletions.<deviceId>.jsonl`, `link: true` on re-encounter lines); the old shared files stay as a read-only base. Jobs carry `deviceId`/`deviceName`, sessions `activeTurn`. | chat 1, settings 1, **graph format 2** |
| Folders from before 0.3.0 | Ledger-like files nothing reads any more: `graph/edges.jsonl`, `events.jsonl`, `mappings.jsonl`, `naming-runs.jsonl`, `cluster-labels.jsonl`, `embeddings.json`, `legacy-graph/`. Sessions written before the native message record (2026-09-26) are unreadable by every build since. | |

Everything else that changed between `v0.3.0` and `v0.4.2001` is an optional field read with a default (`cacheWrite1hTokens`, job `delivery`, `input`, `calls`, `NotesSource.vaultFp`, `source-organization.json`), so such records need no rewrite. The only two on-disk breaks are the **layout split** (layout 1 to 2, which the app already performs at start: `src/store/local-migration.ts`, `migratePromptSwitches`) and the **graph format stamp 1 to 2**, which the app raises lazily at the first graph write.

**Upstream newer than the fork.** None today: `origin/main` is `e69e852` = `v0.4.1` = the merge base of `vault-integration` (fetched 2026-11-01). If a later upstream release raises a stamp (`CURRENT_CHAT_VERSION`, `CURRENT_GRAPH_FORMAT_VERSION`), the fork's existing honest refusal applies and so does ours: `scanDataFolder` reports `blocked: data_newer`, `upgradeDataFolder` throws `MigrationRefusedError` before changing anything, and the vault routes answer `409 data_newer` ("update the app"). A newer upstream that only adds optional fields or files is carried as is: documents are opaque to the sync, unknown files are neither synced nor deleted. Data of the fork never goes back to upstream builds (the format stamp 2 makes them refuse it).

## What the app already did before this work

- At every start (`src/server/stores.ts`): `migrateDeviceLocalData` (legacy settings, positions, render settings, debug move to the local folder, only when the twin is missing), `migratePromptSwitches`, `migrateCustomEndpoints`; the graph store deletes `edges.jsonl` and `events.jsonl`.
- Vault, first sign-in with local data (`runtime.ts bootstrap`): an empty vault is **seeded** with the whole folder (`seedFirstDevice`); a vault with records asks, and "Use the vault" moves every local file to `<local>/pre-vault-<date>/` (own ledger files stay when the vault holds a prefix of them), then downloads (`joinWithExistingData`).
- `assertNotSyncthing` refuses the vault while `.stfolder`, `.stignore` or `.stversions` are in the data folder or above it.

What was missing: no backup, no report, nothing for conflict copies or torn files, dead ledger files that the vault client would seed as shared ledgers, jobs of a stopped build that every other device would read as its own, a Syncthing refusal with only an error string, and a join that threw away the merge option.

## Design

### Order of events

```
older folder --(1 upgrade: backup, then idempotent steps)--> current format
  first device:  --(2 seed: sign up uploads everything)--> vault
  other devices: --(1 upgrade)--> --(3 join: Use the vault, or Merge with the vault)--> vault
```

Step 1 runs automatically at the first start with an account on this device, inside `bootstrap`, before the seed or the join. The dry run (`GET /migration/report`) works signed out and is what the Vault settings show before sign-in.

### 1. Upgrade (`upgradeDataFolder`)

- **Backup first.** A copy of the data folder (without `.stversions`, `.stfolder` and `debug/`) plus the device-local files the steps touch goes to `<local>/backups/migration-<run>/`. It is written to `...partial` and renamed, so a half copy is never mistaken for a backup. The local folder must be outside the data folder (refused otherwise): a backup inside would be synced.
- **Steps**, each derived from what is on disk (so each is idempotent) and journaled in `<local>/migration/journal.json` (temp file + rename). A crash leaves an unfinished journal; the next run resumes with the same backup and finishes.
  1. `local-split`: legacy `settings.json`, `graph/positions.json`, `graph/render-settings.json`, `debug/` move to the local folder when their twin is missing; a stale legacy copy next to an existing twin is set aside.
  2. `prompt-switches`: `agent.prompts` of the settings record merges (a switch on anywhere stays on) into `prompts/switches.json`.
  3. `stray-files`: torn writes (`*.tmp-xxxxxxxx`, `.syncthing.*.tmp`, `~syncthing~*.tmp`), unreadable session or job files, and the dead ledger files listed above move to `<local>/migration/set-aside/<run>/`.
  4. `conflicts`: see below.
  5. `graph-format`: stamps `graph/format.json` version 2 when the folder has graph data and an older (or no) stamp.
  6. `job-owner`: a job still `running` without `deviceId` gets this device's id and name, otherwise every device that joins would read it as its own and try to recover it.
- **Never deletes.** Everything that leaves the data folder goes to `<local>/migration/set-aside/` or `<local>/conflicts/`; the backup holds the rest. Moves never replace an existing file (`freePath`).
- **Refuses newer data** before any change (see above).
- **A folder with nothing to do is not touched**: no backup, no journal.

### Syncthing, in detail

Syncthing leaves three kinds of things in a shared folder: markers, conflict copies, temp files.

- **Markers** (`.stfolder`, `.stignore`, `.stversions`). Removing a folder in Syncthing's own screen leaves them behind, and the vault refuses them. The Vault settings show a guide (`planSwitch`, `migrationReport` route): close the other devices, remove the folder from Syncthing on every device (Remove, not Delete), then "I removed it everywhere". Then the app **renames** the markers inside the data folder out of the way (`setAsideMarkers`: to `<local>/migration/syncthing-<stamp>/`, or beside them when that is another file system). Nothing is deleted, `.stversions` keeps every old version, and a Syncthing that still shares the folder stops by itself because its `.stfolder` is gone. A marker **above** the data folder (Syncthing shares the whole tree) is only reported: the learner removes it by hand and presses "Check again".
- **Conflict copies** (`<name>.sync-conflict-<date>-<time>-<DEVICE>.<ext>`). The vault client does not sync them (`isDocumentPath`). The upgrade sorts them:
  - Session copies (`chats/<id>.sync-conflict-...json`) **stay** where LearnHarness's conflict picker reads them (`conflictPattern` in `src/store/chats.ts`; the learner picks a version in the session list, which then syncs as an ordinary edit). If the original session file is missing, the copy is promoted to be the session.
  - A copy of a shared base ledger (`graph/nodes.sync-conflict-...jsonl`, also chains, sessions, coverage) is **merged**: the lines the ledger lacks are appended (a ledger is a set of JSON lines), then the copy moves to `<local>/conflicts/`. Because ledgers were rewritten by upstream's session deletion, a line deleted on one branch can come back; that is the safe direction.
  - Every other copy (prompts, jobs, `sources.json`, other devices' ledgers) moves to `<local>/conflicts/<path>`, reported, recoverable by hand.
- **Temp files** go aside with the other torn writes.
- **Order across devices.** Remove the folder from Syncthing on every device first; sign up on the device with the most complete data; sign in on the others and choose merge. Syncthing and the vault must never share a folder: the vault client writes pulled files into it.

### 2. Seeding

Unchanged (`seedFirstDevice`): the upgraded folder is uploaded, base ledgers as `ledger/<name>/base/...`, own files by device id, documents once. The upgrade is what makes this safe for old folders: no dead ledger can be seeded as a shared ledger, no half-written file is pushed, and the graph stamp the vault holds is 2.

### 3. Joining a vault that has data

The join screen offers, when this device holds local files:

- **Merge with the vault** (new, the first button): runs the existing "Use the vault" (files move to `<local>/pre-vault-<date>/`, the vault's versions are downloaded, own ledgers that are a prefix of the vault's stay), records the bootstrap as done, then `mergePreVault` folds the moved-aside folder back in. Rules, per record:
  - **Session** only here: added. Same id and identical: nothing. The vault's copy continues this one: the vault's stays. This device's copy continues the vault's (the vault's messages are a prefix): this device's becomes the new head (the vault's history keeps the old one). Diverged: the vault's stays and this device's is written beside it as `<id>.sync-conflict-<date>-<time>-<device>.json`, the name the conflict picker reads (device-local, it never syncs).
  - **Job** of a session that exists: added when missing; a different job file keeps the vault's and saves the other in `<local>/conflicts/jobs/`. Jobs of sessions that exist nowhere are skipped.
  - **Prompt files**: added when missing, otherwise the vault's wins and the local one is saved in `<local>/conflicts/prompts/`. **Switches** merge (on anywhere stays on). **Sources**: entries the vault lacks are added.
  - **Graph**: lines the vault lacks (compared as whole lines, a node counts the same with or without its link mark) are appended to **this device's own** ledger files; a node whose id the vault already has is written as a link line. No other device's file is touched, and other devices' ledger files in the moved-aside folder are left (they come from the vault).
  - Every write notes its intent with the sync engine first, the moved-aside folder is never modified, and a second run changes nothing (compared against live state, tested end to end).
- **Use the vault**: as before. It is now easy to undo: Settings, Vault, "Moved aside" lists each `pre-vault-<date>` folder with its session count and a "Merge into the vault" button (`POST /migration/merge`). That is the restore path for anyone who chose it, now or later.
- **Cancel and sign out**: nothing changes.

Why this and not an automatic merge at join: the vault's state is only known after the download, and two devices must never overwrite each other silently (ADR 0002: nothing merges or is discarded automatically). Moving aside first keeps the vault's version authoritative and every local byte available; the merge then only adds, and keeps the other side of every difference.

Two devices, diverged copies, in one line each: sessions never duplicate (same id), a session both continued keeps both versions (picker), graph lines are added once, jobs and prompts follow the vault, and a device that is not merged loses nothing because its files wait in `pre-vault-<date>`.

### Android

`DataLocation.migrateSharedToPrivate` (Android repo, `vault-integration`) copies everything under `/storage/emulated/0/LearnHarness/data` into app-private `files/data` once, never overwrites, never deletes the shared folder. Consequences for this flow:

- Since the Android repo's c67f701 the copy leaves Syncthing's files (`.stfolder`, `.stignore`, `.stversions`) behind. Builds before that copied them; for such a private folder the same Syncthing guide and set-aside apply, because the markers are then inside the data folder.
- Conflict copies are copied too, and the upgrade sorts them as above.
- The shared folder stays behind and keeps syncing with the desktop through Syncthing. The user must remove it from Syncthing on every device (the guide's step 2), otherwise the shared copy and the private copy diverge. Nothing in this repo deletes it.
- The upgrade runs on the private copy (`LH_DATA_DIR` = `files/data`), with the backup in the private local folder, so the backup never sits in shared storage.

## What the user sees

| Scenario | Screens |
| --- | --- |
| Upstream or old fork folder, first device | Vault settings, before signing in: "The data on this device: 3 sessions, 1 job. On the first sign-in LearnHarness first copies this folder to a backup on this device, then updates it. Nothing is deleted." with the list of steps. Sign up. The upload starts; later the same card shows "Last backup: ...". |
| Same, already current format | "This data is ready for the vault." |
| Syncthing folder | "This folder is shared with Syncthing" with four steps and "I removed it everywhere" (or, for a marker above the folder, "Check again"). After it: "Syncthing's marker files are moved aside and kept. You can sign in now." Sign-up or sign-in before that still answers the existing "shared with Syncthing" error. |
| Conflict copies | The data card says how many were found; session copies appear in the session list's existing conflict picker; the others are in the conflicts folder. |
| Second device with data, vault has records | Join screen: "Merge with the vault" (explained in one sentence), "Use the vault", "Cancel and sign out". |
| Used the vault earlier | Settings, Vault, "Moved aside": `pre-vault-20261101: 2 sessions, 7 files` with "Merge into the vault"; afterwards "Added 2 sessions and 5 graph lines. 1 conflict copy to review." |
| Data from a newer build | "This data was saved by a newer LearnHarness. Update the app first. Nothing was changed." |

## Fixtures and tests

`tests/fixtures/migration/<release>/{lh-data,lh-local}` are written by `tests/fixtures/migration/generate.ts`, which imports the **store code of a checked-out release** and writes sessions, jobs (one finished, one left running), graph ledgers, sources, prompt overrides, settings, positions (`git worktree add --detach /tmp/lh-old/v0.4.1 v0.4.1`, symlink `node_modules`, run the script). Releases: `v0.3.0` (oldest upstream, plus synthetic dead ledger files), `v0.4.1` (newest upstream), `v0.3.6001` (fork before the split), `v0.3.8001`, `v0.4.2001` (fork after it). The dead pre-0.3.0 files are the only invented bytes; no release writes them any more. The folders are named `lh-data`/`lh-local` because `.gitignore` ignores `data/` and `local/`.

- `tests/migration-upgrade.test.ts`: per release dry run (reads only), backup byte for byte, every step, nothing synced altered, second run is a no-op, a crash after every step and during the backup is finished by the next run with the first backup; Syncthing markers, conflict copies, set-aside; newer data; torn files; local folder inside the data folder.
- `tests/migration-merge.test.ts`: merge rules above, intent-first notes, idempotence.
- `tests/migration-ui.test.tsx`, additions to `tests/vault-routes.test.ts`: screens and routes.
- `tests/migration-vault.test.ts`: against a real vault server (`LHV_REPO`, `LHV_TEST_DATABASE_URL`, `GOTOOLCHAIN=go1.26.0`): upstream 0.4.1 folder signs up and a second device receives every record byte for byte; Syncthing folder refused, guided, migrated; two diverged devices merge; "Use the vault" then a later merge; a session deleted in the vault stays deleted when an old copy is merged; newer data stops the sign-in.

## Limits and open points

- A document **deleted in the vault** is not brought back: the merge first syncs, then asks the vault client (`SyncEngine.documentState`, client 0.3.0, from the authenticated record headers) and skips documents whose head is a deletion. The report lists them (`deletedInVault`), and the old copies stay in the moved-aside folder. If the sync fails, the merge stops and the folder stays for a later try.
- A ledger copy merged from a Syncthing conflict can bring back lines that upstream's session deletion removed from the other branch. Owner decision (2026-11-01): keep lines rather than risk losing them.
- The join screen offers "Merge with the vault" as the main button (owner decision, 2026-11-01).
- Merging does not run on devices that already completed their first start; the "Moved aside" list is the only entry point later.
- Unreadable sessions (including those from before the native message record) are set aside and named in the report, never repaired.
- Upstream-format data cannot be moved back to an upstream build.
