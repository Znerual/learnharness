# One graph ledger per device

Every device extracts into the knowledge graph, and the sync tool replicates whole files, so a single shared `nodes.jsonl` written by two devices between syncs would produce conflict copies. Each device therefore appends only to its own ledger files (keyed by its device ID), and every device reads the union of all devices' ledgers. Two devices never write the same graph file, so the graph never conflicts and never needs an automatic merge.

## Consequences

- Two devices that are out of sync can each create a node for the same proposition. v1 accepts these duplicates; a later merge pass can re-audit lines that arrived from another device.
- Deletion appends a deletion record to the deleting device's own ledger, and readers skip what it names. No device ever rewrites another device's file, so deleted data stays on disk.
- The ledgers that existed before this change stay as a shared, read-only base that every device reads and none writes again. Renaming them into one device's files would duplicate them when two devices upgrade from copies of the same files.
- `sources.json` stays one shared file, because in v1 only the desktop imports notes.
