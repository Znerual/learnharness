# Local dictation and read-aloud

Besides Deepgram, dictation can use a **local engine**, and replies can be **read aloud**.
Both can talk to a speech server you run yourself through the OpenAI audio API. Read-aloud
can instead use the **built-in voice engine** (OmniVoice on this computer, below), which the
desktop app downloads on request. (The Android app ships its own on-device server and fills
these settings in by itself.)

## What the app calls

Both settings take a base URL that ends where the OpenAI paths begin, for example
`http://localhost:8000/v1`, and an optional key sent as `Authorization: Bearer <key>`
(stored in `auth.json` as `LH_STT_KEY` and `LH_TTS_KEY`).

| Feature | Request | Expected answer |
|---|---|---|
| Dictation (engine "Local") | `POST <url>/audio/transcriptions`, multipart: `file` (16 kHz mono WAV of the whole recording), `model` (the Model setting, default `whisper-1`), `response_format=json` | `{"text": "…"}` |
| Read-aloud | `POST <url>/audio/speech`, JSON: `{"model": "tts-1", "input": "…", "voice": "<Voice setting>", "response_format": "mp3", "speed": …, "language": "en" \| "de"}` (`voice` only when set; servers with one language ignore `language`) | audio bytes (any type the browser plays) |
| Read-aloud voice list (optional) | `GET <url>/audio/voices` | `{"voices": ["af_heart", …]}` (strings or `{id, language?}` objects); without it, type the voice name |
| Add a voice clip (optional) | `POST <url>/audio/voices`, multipart: `name`, `transcript` (the words spoken), `audio` (3–10 s WAV or MP3) | 201 `{"id": "clip-…", "name": "…"}`; 409 `{"error": {"code": "voice_exists"}}` |
| Delete a voice clip (optional) | `DELETE <url>/audio/voices/clip-…` | 204; 404 when unknown |

Dictation sends one recording when you stop, not a stream, so any server that transcribes
a WAV file works. Read-aloud sends one block of text at a time (a paragraph, a list item,
an equation spelled out in words) and plays the blocks in order.

## Servers that speak this API

Any OpenAI-compatible speech server should work. Projects that implement these routes
include [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper for
transcription; set the dictation Model to the model id it serves) and
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (Kokoro voices for
`/audio/speech` and `/audio/voices`). They are examples, not tested setups: check each
project's documentation for the model ids and voice names it accepts, since read-aloud
always sends `model: "tts-1"`. [AudioAgent](https://github.com/Znerual/AudioAgent) serves all of
the routes above: Kokoro voices through its sidecar, OmniVoice voices (English and German, the
`omni-*` presets) and voice clips in-process.

## The built-in voice engine (OmniVoice)

**Settings → Providers → Read aloud → Voice engine → On this computer (OmniVoice)** reads aloud
without any server. It needs a GPU: an NVIDIA GPU with its driver on Linux or Windows (x64), or
a Mac with Apple silicon. On a CPU it would read many times slower than speech, so it is not
offered there.

- **Download**: the first use asks you to accept the licenses and downloads about 4 GB: the
  [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) model (weights CC BY-NC 4.0,
  non-commercial; audio tokenizer under Boson AI's Higgs Audio 2 Community License), the
  [omnivoice-rs](https://github.com/FerrisMind/omnivoice-rs) engine (Apache-2.0) and, for NVIDIA,
  NVIDIA's cuBLAS and cuRAND libraries. Every file is pinned by size and SHA-256 and lands in
  the device-local folder (`omnivoice/`), never in the synced data folder. **Remove** deletes it.
- **Running**: the engine starts with the first block read aloud (a cold start takes 20–40 s),
  listens on 127.0.0.1 only with a key of its own, takes one block at a time, and stops after
  10 minutes without reading. It needs about 2 GB of GPU memory while it runs.
- **Voices**: four presets (`omni-female-low`, `omni-female-high`, `omni-male-low`,
  `omni-male-moderate`), each a fixed voice description and seed, for English and German; plus
  your own voice clips (below). AudioAgent offers the same four ids.

## Setting it up

1. Start your server and note its base URL (including `/v1`).
2. **Settings → Providers → Dictation**: choose the engine **Local**, enter the URL, and
   the model if your server needs one. Add the key under that row if the server wants one.
3. **Settings → Providers → Read aloud**: choose the voice engine **Speech server**, enter the
   URL, pick a voice, and add the key if needed (or choose **On this computer** and download
   it). The speaker button on each reply then reads it; the toggle beside the microphone reads
   every new reply.

## Your own voices (voice clips)

**Settings → Providers → Read aloud → Your voices → Add a voice** clones a voice from a short
recording: a 3–10 s WAV or MP3 of one speaker and the exact words spoken in it. The clip is
added to the chosen engine (the speech server, if it takes clips, or the built-in engine, which
keeps it in the device-local `speech-voices/` folder) and shows in the voice list as
`clip-<name>`. Only add a voice you have the right to use.
