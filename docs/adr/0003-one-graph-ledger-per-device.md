# One graph ledger per device

Every device extracts into the knowledge graph, and the sync tool replicates whole files, so a single shared `nodes.jsonl` written by two devices between syncs would produce conflict copies. Each device therefore appends only to its own ledger files (keyed by its device ID), and every device reads the union of all devices' ledgers. Two devices never write the same graph file, so the graph never conflicts and never needs an automatic merge.

## Consequences

- Two devices that are out of sync can each create a node for the same proposition. v1 accepts these duplicates; a later merge pass can re-audit lines that arrived from another device.
- Deletion appends a deletion record to the deleting device's own deletions file, and every read replays all devices' records through the same pure rules the single-device deletion used. No device ever rewrites a ledger, so deleted data stays on disk.
- A session deletion covers the lines written up to its time, so a session continued on another device after the deletion contributes again. Node and argument deletions are permanent: a link line to a deleted node, written by a device that had not synced the deletion, is dropped.
- Link lines carry `link: true`, so the unmarked line defines a node whichever device's file is read first; in the legacy base, file order still decides.
- Chain simplification runs on read instead of rewriting the chains ledger during a merge. Deleting a lean argument lets a redundant argument it was hiding show again; that is accepted, since the redundant one is valid on its own.
- A session deletion keeps the session's coverage rows, so a session continued on another device does not re-extract what the deletion removed.
- An argument deletion names the argument's premises and conclusion, and removes every assertion of it, whichever device minted which id.
- The session-deletion cutoff compares the deletion's time with the time each line was written, so it relies on the devices' clocks. A device with a wrong clock could have lines wrongly removed or kept; this is accepted because phones and desktops sync their clocks over the network.
- The ledgers that existed before this change stay as a shared, read-only base that every device reads and none writes again. Renaming them into one device's files would duplicate them when two devices upgrade from copies of the same files.
- `sources.json` stays one shared file, because in v1 only the desktop imports notes.
