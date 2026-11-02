# Voice samples

Short samples of the on-device read-aloud voices, so a voice can be heard in
Settings → Read aloud before its model is downloaded
(`components/settings/on-device-speech.tsx`, `voiceSampleUrl`).

- `voice-*.mp3`: the Piper voices' own samples (`samples/speaker_0.mp3`) from
  https://huggingface.co/rhasspy/piper-voices, renamed to the app's model ids.
  Each voice keeps its model's license (see its `MODEL_CARD` there).
- `kokoro.mp3`: the first 11 seconds of `samples/HEARME.wav` from
  https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0), as 56 kbit/s MP3.

A new voice in learnharness-android's `PiperVoice.kt` needs its sample here and
its id in `VOICE_SAMPLES`; without one it simply has no Listen button.
