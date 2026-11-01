# Voice mode's microphone is native on Android

On Android, voice mode listens through the app's own Kotlin code, not through the page: a foreground service of type `microphone` records with the voice-communication audio source (for echo cancellation during read-aloud), detects speech with an on-device voice activity detector, transcribes each utterance on-device, matches voice commands, and hands each utterance or command to the page. The page owns everything else: where dictated text lands, send versus steering, and pausing, resuming, restarting and stopping read-aloud. We split it this way because Android only allows background microphone access from a foreground service of type `microphone`, and capture inside a WebView with the screen off is unverified and fragile, while keeping turn and read-aloud logic in the page keeps it single-source and upstreamable (ADR-0001, ADR-0004).

## Considered Options

- All in the page: the page already captures the microphone for dictation, but nothing guarantees that capture keeps running in a WebView with the screen off, and voice activity detection would have to run in JavaScript.
- All native: robust in the background, but it duplicates turn handling and read-aloud outside this repo, and the desktop would never get voice mode.

## Consequences

- Voice mode can only be turned on while the app is on screen; Android refuses to start a microphone foreground service from the background.
- In voice mode the dictation engine setting is ignored: the phone always transcribes on-device.
- The page receives utterances through a small interface, so the desktop can later feed the same interface from voice activity detection in the browser.
