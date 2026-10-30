# LearnHarness

An agent harness for learning. Runs on more than one device; every device is a full, equal client, and devices share one learner's sessions and knowledge graph.

## Devices and sync

**Device**:
One installation of LearnHarness, desktop or phone, with a stable identity and a learner-editable name. All devices are equal: each can run sessions, background jobs, and graph extraction.
_Avoid_: client, instance, host

**Data folder**:
The folder holding a learner's synced records (sessions, knowledge graph, jobs, prompt overrides). Every device has its own copy; the sync tool keeps the copies identical.
_Avoid_: data dir, store, vault

**Device-local data**:
Records that belong to one device and never sync: settings, API keys, debug recordings.
_Avoid_: private data, local settings

**Handoff**:
Continuing a session on another device after the previous device's work on it has synced.
_Avoid_: transfer, resume

**Owning device**:
The device on which a turn or background job runs. Only the owning device may change that turn or job; other devices show it as running elsewhere.
_Avoid_: host device, origin

**Takeover**:
The learner's confirmed action that removes another device's stale ownership of a session, so this device can continue it.
_Avoid_: unlock, force, steal

**Conflict copy**:
A second version of a file that the sync tool keeps when two devices changed the same file before syncing. LearnHarness shows it to the learner to choose; it never merges or discards one silently.
_Avoid_: duplicate, fork
