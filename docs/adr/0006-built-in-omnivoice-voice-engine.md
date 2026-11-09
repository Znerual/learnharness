# Read-aloud has a built-in OmniVoice engine on desktop

Read-aloud can speak through OmniVoice running on the learner's own computer, without a speech server: Settings → Read aloud offers the voice engine "On this computer (OmniVoice)" next to "Speech server". The desktop app downloads the prebuilt omnivoice-rs server (a Rust/Candle port of OmniVoice with an OpenAI-compatible API), the OmniVoice model at a pinned revision, and on NVIDIA machines NVIDIA's cuBLAS and cuRAND libraries, all pinned by size and SHA-256, into the device-local folder. It starts the engine on loopback for the first block and stops it after ten idle minutes. We did this because the only German voices so far came from the phone, Kokoro speaks no German, and a learner without a GPU server should still get good speech in both languages; OmniVoice reads English and German well and clones a voice from a short clip.

## Considered Options

- Only through AudioAgent (the owner's speech server): no download in the app, but read-aloud then needs a second program on every computer.
- The official Python OmniVoice, set up by the app with uv: half the time per block of the Rust port on the owner's GPU, but a Python environment and PyTorch (about 2.5 GB more) on every platform.
- OmniVoice through ONNX in Node: no ready export or inference loop exists; we would port the diffusion loop and the audio tokenizer ourselves.
- The CUDA runtime from the omnivoice-rs release: its cuBLAS 12.6 has no Blackwell (RTX 50) kernels and read slower than playback there, so the libraries come from NVIDIA's own wheels (12.9) instead.

## Consequences

- GPU only. On the owner's laptop the CPU path ran at about 11 seconds of work per second of speech; the option explains why it is unavailable on a computer without an NVIDIA GPU or Apple silicon, and the Android app never shows it.
- The download is about 4 GB on NVIDIA machines. The model weights are CC BY-NC 4.0 and the audio tokenizer has Boson AI's community license, so the app shows both before the download and never ships them. The owner ruled (2026-11-09) that both editions may offer it, since the vault edition sells only file sync.
- An explicit choice: the built-in engine never stands in for an unreachable speech server.
- Voice clips live in the engine they were added to: the built-in engine's in the device-local `speech-voices/`, AudioAgent's in AudioAgent. They do not sync.
- The engine's state lives on `globalThis`, because Next loads a server module once per route bundle; a per-module variable let "Remove" miss the engine that read-aloud had started.
