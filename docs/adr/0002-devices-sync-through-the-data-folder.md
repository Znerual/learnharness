# Devices sync through the data folder

Devices stay in sync by replicating the data folder with a file-sync tool, peer to peer, with no sync server and no sync code in LearnHarness itself. Each device works offline from the others (it still needs internet for the LLM provider) and catches up when the devices see each other again. A session is used on one device at a time; when a conflict copy appears anyway, the apps surface it and the learner picks a version — nothing merges or is discarded automatically.

## Considered Options

- A git repo of the data folder: history for free, but merging on the phone is awkward.
- A cloud drive: depends on a third party and on Android's storage-access layer.
- A custom sync protocol between the apps: most control, but all sync logic would be ours to write and debug.

## Consequences

- A file-sync tool replicates whole files, not lines. Any file that two devices can write between syncs produces a conflict copy, even an append-only one.
- Device-local data (settings, API keys, debug recordings, graph layout and display settings, the device identity) lives outside the data folder, so the data folder holds only synced records and nothing depends on the sync tool's ignore rules.
- A session deleted on one device while another device continued it comes back when they sync: the sync tool restores the changed file. Its earlier graph contributions stay deleted. This is accepted; losing the continued turns would be worse.
- Prompt overrides sync together with their on/off switches, so every device teaches a session with the same prompts.
- Model configuration is device-local. When a handed-off session's model is not configured on this device, the learner picks a model for the session; nothing switches silently.
- A turn or job writes its owning device into the session record while it runs. Other devices show the session read-only; a stale marker can be cleared with a confirmed takeover.
- On the phone, a foreground service keeps the server alive while a turn or job runs, so Android does not kill work in progress.
- The phone keeps its data folder in shared storage (it needs "All files access") so a separately installed file-sync app can reach it; this is acceptable because the app is sideloaded, not distributed through the Play Store.
