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

## Thinking and speech

**Learner thinking**:
The learner's own reasoning, written into a "Your thinking" field (while reading, on a question, or on a practice problem) and sent to the agent alongside or instead of an answer.
_Avoid_: user thinking, notes

**Agent thinking**:
The model's reasoning during a turn, shown collapsed above its reply.
_Avoid_: reasoning, thoughts

**Steering**:
A learner message sent while a turn runs; the running agent takes it in at its next step instead of starting a new turn.
_Avoid_: interrupt, injection

**Read-aloud**:
Speaking a reply or question to the learner, block by block.
_Avoid_: TTS, playback

**Dictation**:
Turning the learner's speech into text in the field that currently holds the dictation claim.
_Avoid_: transcription, speech input

**Voice mode**:
A hands-free state for one device in which the device listens continuously, dictates each utterance without a button, reads every new reply and question aloud, and accepts voice commands; it keeps working with the screen off.
_Avoid_: conversation mode, hands-free mode, live mode

**Barge-in**:
The learner starting to speak during read-aloud in voice mode, which pauses the read-aloud until a voice command resumes, restarts or stops it.
_Avoid_: interruption

**Voice command**:
A short fixed phrase that makes up a whole utterance in voice mode and controls read-aloud or moves the session along instead of being dictated: continue, restart, stop, send, reveal, next, voice off.
_Avoid_: keyword, wake word
