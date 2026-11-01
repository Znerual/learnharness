# Local dictation and read-aloud

Besides Deepgram, dictation can use a **local engine**, and replies can be **read aloud**.
Both talk to a speech server you run yourself through the OpenAI audio API. Nothing is
bundled with the desktop app: you choose and run the server. (The Android app ships its
own on-device server and fills these settings in by itself.)

## What the app calls

Both settings take a base URL that ends where the OpenAI paths begin, for example
`http://localhost:8000/v1`, and an optional key sent as `Authorization: Bearer <key>`
(stored in `auth.json` as `LH_STT_KEY` and `LH_TTS_KEY`).

| Feature | Request | Expected answer |
|---|---|---|
| Dictation (engine "Local") | `POST <url>/audio/transcriptions`, multipart: `file` (16 kHz mono WAV of the whole recording), `model` (the Model setting, default `whisper-1`), `response_format=json` | `{"text": "…"}` |
| Read-aloud | `POST <url>/audio/speech`, JSON: `{"model": "tts-1", "input": "…", "voice": "<Voice setting>", "response_format": "mp3", "speed": …}` (`voice` only when set) | audio bytes (any type the browser plays) |
| Read-aloud voice list (optional) | `GET <url>/audio/voices` | `{"voices": ["af_heart", …]}` (strings or `{id}` objects); without it, type the voice name |

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
always sends `model: "tts-1"`.

## Setting it up

1. Start your server and note its base URL (including `/v1`).
2. **Settings → Providers → Dictation**: choose the engine **Local**, enter the URL, and
   the model if your server needs one. Add the key under that row if the server wants one.
3. **Settings → Providers → Read aloud**: enter the URL, pick a voice, and add the key if
   needed. The speaker button on each reply then reads it; the toggle beside the
   microphone reads every new reply.
