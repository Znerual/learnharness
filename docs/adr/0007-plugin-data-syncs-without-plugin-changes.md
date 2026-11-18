# Plugin data syncs without plugin changes

Status: Proposed (2026-11-18). The vault side is learnharness-vault ADR 0014 (delta chains).

Plugins keep writing plain files in their data folder (`ctx.dataDirectory`): `core-plugin-data/<id>/` for core plugins, `local/plugins/<id>/data/` for community plugins. With the vault on, the host syncs those files itself, so an existing plugin syncs without any change to its code or manifest. Until now the vault synced no plugin data at all (`isDocumentPath` in `packages/vault-client/src/sync/mapping.ts`), so Flashcards progress stayed on the device where it was made.

## What syncs

- Every file in an active plugin's data folder, including the host-owned `tasks/` and `agents/` records, which carry their owning device (ADR 0002's owner rule).
- Never: names starting with a dot, `*.tmp`, symlinks, and extensions outside the allow list `json`, `jsonl`, `md`, `txt`, `png`, `webp`. Executable or active content (`js`, `cjs`, `mjs`, `node`, `wasm`, `html`, `svg`, `sh`, and every extension not on the list) never syncs. Plugin code never syncs: core code ships with the app, community code lives in `local/plugins/<id>/dist/`.
- A manifest may narrow this with an optional `sync.exclude` list of relative path patterns (Coding Questions excludes `test-runs/`). The field is optional; a plugin without it syncs with the defaults.
- Limits, enforced by the sender before upload and by the receiver before download (the change list carries each record's size): core plugins 4 MiB per file and 64 MiB per plugin, community plugins 1 MiB per file and 16 MiB per plugin, at most 5,000 files per plugin. Plugin data has no separate share of the account quota. A plugin over a limit stops syncing and Settings → Vault shows why; nothing is truncated.

## When a plugin is active

A plugin syncs only on a device where it is **active**: installed, enabled, and, for a community plugin, with sync turned on for that plugin on that device (off by default). A plugin can be active on one device and missing or disabled on another.

- An inactive plugin receives nothing. Its records stay in the vault; the device skips them without downloading (ADR 0014's plugin index).
- When the plugin becomes active (installed, enabled, or sync turned on), the device downloads all of the plugin's current data from the vault before starting the plugin's backend. This also applies to a disabled core plugin that is enabled later.
- Disabling a plugin stops its sync in both directions and keeps its local data. Enabling it again catches up from the vault.
- Uninstalling a community plugin, or turning off its sync, removes its local data (data folder and `ctx.localDataDirectory`) and keeps the vault's copy: no tombstones are written. Installing it again downloads everything from the vault. Deleting the vault's copy is a separate action in Settings → Vault, with confirmation and re-authentication (vault ADR 0013; the grant is spent with `POST /v1/reauth/consume`, which sends the notice email).
- The vault index carries each community plugin's identity (manifest name and source). When the installed plugin's identity differs from the one in the vault, the device asks before importing, because another plugin with the same id would otherwise read the data.

## Finding local changes

Plugins write files directly, so there is no store adapter to wrap. The host scans an active plugin's data folder (size and mtime, then SHA-256) after each backend operation through the JSON bridge, after each plugin worker finishes, every 60 s, and at shutdown. A changed file goes to the outbox; a removed file is a deletion. Uploads of the same file are coalesced to at most one every 60 s. A removal by uninstall or by sync being turned off is never a deletion.

## Applying remote changes

Plugins keep state in memory (Flashcards reads `flashcards.json` once in `openStore`), so a file written underneath a running backend would be overwritten by its next write. The host therefore:

1. waits until the plugin has no running bridge operation and no live worker task (a long generation defers the apply until it ends);
2. stops the plugin's backend through its normal cleanup;
3. writes the files: inside `safePluginDataDirectory` only, path segments matching `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`, at most three levels deep, no symlink on the path, temporary file opened exclusively and then renamed; JSON and JSONL must parse and text must be valid UTF-8, otherwise the record is refused and reported;
4. starts the backend again and tells open plugin views to refresh.

The receiver applies its own rules, not the sender's: a record is accepted only if its path is allowed by the receiver's installed manifest and the rules above. The plugin still checks its own format version, as Flashcards does ("Unsupported or invalid Flashcards data. No data was changed.").

## Merging

A file is one record chain (ADR 0014). When two devices change the same file before syncing, the device that syncs second merges the two versions three ways, with the last synced version as the common ancestor, and syncs the result (owner, 2026-11-18). Unlike ADR 0002, plugin data merges automatically:

- JSON objects merge key by key. Arrays whose elements are all objects with a unique string `id` merge as sets by `id`, keeping order. Other arrays merge element by element; appends on both sides are both kept.
- A key or element deleted on one device and changed on the other is kept with the change (as for sessions in ADR 0002).
- The same value changed differently on both devices takes the vault's value. The local value is kept in a conflict copy, `local/conflicts/plugins/<origin>/<id>/<path>.<yyyymmdd>-<hhmmss>`, which Settings → Vault lists.
- Text files (`md`, `txt`, `jsonl`) merge by lines, like other arrays: lines inserted at the same place on both devices are both kept (the vault's first); other overlapping changes are handled like the same value changed on both devices. Images take the vault's version.
- If the plugin refuses the merged file when it restarts (its format check throws or activation fails), the host writes the vault's version instead, keeps the local version as a conflict copy, and starts the plugin again.

## Device-local plugin data

The host gives each plugin `ctx.localDataDirectory`, a folder that never syncs (in the fork under `LH_LOCAL_DIR/plugin-local/<id>/`; upstream, a sibling of the data folder). It is the place for per-device values such as an install id or a model override. It stays in the fork for now (owner, 2026-11-18: no upstream PR).

## Flashcards

In the fork only for now (owner, 2026-11-18: no upstream PR):

- Each install keeps an install id in `ctx.localDataDirectory` and appends its reviews to `reviews/<installId>.jsonl`. Only that install writes the file, so reviews made offline on two devices never meet in a merge, and each upload is a small append delta.
- The schedule of a proposition is rebuilt by replaying all installs' reviews in time order, with the current settings (owner, 2026-11-18).
- The daily new-card limit belongs to the learner, not the device: it counts the reviews of every install (owner, 2026-11-18). Two devices used offline on the same day can each admit up to the limit before they sync.
- Decks, propositions and cues stay in `flashcards.json` and merge as described above.
- `modelOverride` moves to device-local settings in `ctx.localDataDirectory`, as model configuration is device-local (ADR 0002).

## Considered Options

- A storage API for plugins (`ctx.documents`, `ctx.ledger`, `ctx.blobs`): sync could not go wrong, but every plugin would have to change. Rejected by the owner (2026-11-18): sync must work for unchanged plugins.
- Whole-file document records: simple, but Flashcards rewrites its whole file on every rating, and with 90 days of version history that fills the quota. Replaced by delta chains (ADR 0014).
- The vault's version wins and the other goes to a conflict copy, as for jobs: no merge code, but reviews made offline on a second device would leave the app. Replaced by the three-way merge (owner, 2026-11-18).
- Git (isomorphic-git) for history and merging: its merge works on lines, so one-line JSON such as `flashcards.json` would always conflict, and its object store and garbage collection do not fit a vault of encrypted records.
- Automerge (a JSON CRDT): merges without a common ancestor, but adds a WebAssembly dependency on the Android server, has to infer edits from whole-file JSON writes, and keeps a history that cannot be trimmed safely while a device is offline.
- Syncing a disabled core plugin's data in advance: rejected (owner, 2026-11-18); data arrives only on activation.
- Keeping plugin tasks and agent sessions device-local: rejected (owner, 2026-11-18); they sync and keep their owning device.

## Consequences

- A plugin that writes executable content into its data folder under an allowed extension and runs it is not stopped by the host; plugins are trusted code (`docs/plugin-architecture.md`). The rules above stop the sync from placing code, symlinks or files outside the data folder.
- Restarting a backend to apply changes interrupts nothing in progress, because the apply waits for running operations and workers. A device that generates for a long time applies other devices' changes later.
- Single-device users and upstream builds see no change; `ctx.localDataDirectory` is the only API addition (ADR 0004).
- A merged file is valid JSON but can break a plugin's own invariants (a deck deleted on one device and given a card on another comes back). The plugin's format check and the fallback above keep a refused merge from replacing the vault's version.
