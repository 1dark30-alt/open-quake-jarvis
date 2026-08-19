# Live Translate

Real-time speech **translation captions on the panel**. Point the mic at a conversation, a film, or
a meeting and watch it translated into your language, live — word by word, as it's spoken, not after
a pause. Add a **Live Translate** page in the [editor](editor.md), pick a provider, and tap the mic
(or the knob, or a [hotkey](#hotkey)).

Two interchangeable providers sit behind one page:

| Provider | Where it runs | Cost | Setup |
|---|---|---|---|
| **Soniox** | Cloud | ~$0.18/hr while translating | Paste an API key |
| **WhisperLive** | Your own NVIDIA GPU | Free / offline | Run a container |

## Soniox (cloud — easiest, best quality)

1. Sign up at [soniox.com](https://soniox.com) and create an API key (there's a free trial credit).
2. In the Live Translate page's editor settings: **Provider = Soniox**, paste the **API key**, and set
   a **target language** (e.g. `en`, `es`, `de` — [browse codes](https://soniox.com/docs/stt/concepts/supported-languages)).
3. Optionally set a **source hint** (the language you expect) — it removes the couple-second warm-up
   Soniox otherwise spends auto-detecting the language.

Your real key never reaches the panel page: open-quake mints a short-lived **temporary key** and the
page authenticates with that. The key is stored encrypted at rest.

## WhisperLive (self-hosted GPU — free and offline)

Runs Whisper large-v3 transcription + NLLB translation on your own NVIDIA card, over a WebSocket. The
container image is **[openquake-translate](https://github.com/TeeJS/openquake-translate)**.

1. On a machine with an NVIDIA GPU + the nvidia-container-toolkit:
   ```bash
   docker run -d --name openquake-translate --gpus all -p 19000:9090 \
     -v oqt-cache:/root/.cache/huggingface ghcr.io/teejs/openquake-translate:latest
   ```
   (An Unraid template ships in that repo under `unraid/`.)
2. In the Live Translate editor: **Provider = WhisperLive**, **URL = `ws://<gpu-host>:19000`**, and a
   **target language**. open-quake requests **large-v3**.
3. **On-demand GPU (optional):** set **start**/**stop** commands so the container only runs while
   you're translating and the GPU is free the rest of the time:
   - Start: `ssh root@<gpu-host> docker start openquake-translate`
   - Stop:  `ssh root@<gpu-host> docker stop openquake-translate`

   open-quake runs the start command when you begin, waits for the port, connects, and runs the stop
   command when you stop. The first session downloads the models into the cache volume, then it's
   instant and offline.

## Extras

- **Save to file** — toggle it on to write the translation to a text file; choose the folder in the
  editor (default `Documents\OpenQuake Translations`).
- **Microphone** — pick the capture device in the page's editor or the on-panel Settings.
- <a id="hotkey"></a>**Toggle hotkey** — set a global key combo in the editor that starts/stops
  translation from any app (it switches to the page and toggles the mic). The **knob** does the same
  when the page is on-screen.

## Which should I use?

Soniox is zero-setup and the best quality — use it unless you specifically want everything local/free.
WhisperLive keeps audio on your own hardware and costs nothing to run, at the price of a GPU and a
container.
