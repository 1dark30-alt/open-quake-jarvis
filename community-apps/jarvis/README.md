# JARVIS Mark 55 — ChatGPT subscription + local British voice

The Open Quake launcher now defaults to **Codex signed in with ChatGPT**, with an offline British voice and offline English speech recognition. No Gemini key, OpenAI API key or paid speech service is needed in this mode. Codex requests count against your plan's Codex allowance; this is not the ChatGPT Voice service.

## Install and use

This fork includes Open Quake 0.8.4 (upstream main at `8f62ce1203bcb515d076fbc536fe34dcdca3d1e8`). The Jarvis drop-in is version 1.2.0 and retains the Mark 55 backend and voice settings. Import the updated ZIP when upgrading an existing installed copy.

1. Install Codex and sign in with ChatGPT. The launcher finds `codex` on PATH or the Windows Codex app's bundled executable. You can set `JARVIS_CODEX_EXE` to its absolute executable path.
2. Import `community-apps/jarvis.zip` into Open Quake (or use this app folder).
3. In the installed app folder, run `python install_mark55.py` with Python 3.11 or newer. It installs an isolated environment, Chromium, the British voice and offline speech-recognition model. Internet is needed for this initial download; subsequent speech processing is local. Re-run after moving the app, since virtual environments are not portable.
4. In the JARVIS options choose **ChatGPT subscription (Codex + local British voice)**. Open the panel and use **Sign in with ChatGPT** if you are not already signed in. Set the same pairing PIN in the app options and local backend.
5. Hold **Ctrl+Space** on Windows to talk, or hold the Quake device knob. Release to send the utterance (maximum 30 seconds). Type commands in either chat box. The Orb toggles microphone mute; **Escape** in the desktop window stops speech and interrupts the current Codex turn.
6. Use **Preview voice** to hear the voice without making a Codex request. Desktop chat also accepts `/login`, `/preview`, and `/stop`.

## Voice

Piper's `en_GB-alan-medium` British male voice runs locally at natural pace and pitch (`local_voice_options: {"pace": 1.0, "pitch": 1.0}`). The voice options override legacy launcher pitch settings. Select the model with `local_voice_model` in `Mark-LV/config/api_keys.json`; `en_GB-vctk-medium` retains the previous Scottish voice if its model is installed. Spoken replies omit code blocks and raw URLs; the avatar follows the audio.

Faster Whisper `base.en` performs CPU transcription locally. Only the resulting text goes to Codex. Push-to-talk records only while held. Wake-word mode monitors locally and suppresses input during speech playback. Transcription defaults to English. The global hotkey integration uses Windows key-state polling; use the Quake knob for other platforms.

Voice and recognition files live in `Mark-LV/models/`. They are downloaded during installation, not bundled in the ZIP. Piper's upstream engine and each downloaded voice have their own licenses and attribution; see the linked upstream documentation and model card below.

## Capabilities and limits

The Codex client supports streamed conversations, native Jarvis actions, requested screen capture, saved memory, and desktop confirmation of Codex command/file approvals. Codex provides general reasoning, file and coding capabilities. Built-in Jarvis tools retain their existing confirmation gates. API-key authentication is rejected in subscription mode, and legacy Gemini helpers are blocked from calling Gemini even if an old key remains in local configuration.

This provider is not a drop-in Gemini Live session. Continuous camera streaming, Gemini voices, proactive Gemini features and Gemini-dependent plugin reasoning are not ported. Some native actions contain legacy AI fallbacks; those paths report that they require Gemini, so Codex can use its own tools instead. Conversation context lasts for the running session; facts explicitly saved with the memory tool persist across restarts. Live requests and dynamic tool dispatch were verified with a ChatGPT Plus sign-in; full Quake hardware and room-microphone testing remains user-dependent.

## Other modes and troubleshooting

Gemini Live remains an explicit option. Select it, supply its API key and restart the backend. Switching an option while a backend is running does not hot-swap the engine. The original `Mark-LV/main.py` also retains upstream Gemini operation.

The Quake integration binds only to `127.0.0.1:8000` and does not change firewall rules. Phone/LAN access is still a separate upstream Gemini mode launched with `Mark-LV/main.py`; use its desktop Remote Control button for a temporary key. The integrated Remote tab explains the local-only connection.

Startup errors appear in `Mark-LV/startup.log`. Missing speech models require running the installer. Missing or expired Codex sign-in can be corrected with the panel button or `codex login`. No credentials are copied out of Codex. The old Mark 46 executable remains in the repository as a rollback copy and is excluded from the package.

## Verify and package

From the repository root, run:

```
community-apps/jarvis/Mark-LV/.venv/Scripts/python.exe -m unittest discover -s community-apps/jarvis/tests -v
python community-apps/jarvis/package_mark55.py
```

The ZIP uses an explicit source allowlist and excludes virtual environments, downloaded models, credentials, recordings, logs and runtime memory.

## Sources and attribution

- [Codex app-server integration and ChatGPT sign-in](https://developers.openai.com/codex/app-server)
- [Piper Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md)
- [VCTK model card](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_GB/vctk/medium/MODEL_CARD)
- [Faster Whisper](https://github.com/SYSTRAN/faster-whisper)
- Supplied Mark LV source by FatihMakes: `Mark-LV/readme.md` and `Mark-LV/LICENSE`.

## Hey Jarvis wake word

Enable **Settings → Wake Word** in the desktop Jarvis window. The first use downloads the local detector. Say **Hey Jarvis**, pause briefly for the “Awake” log, then speak your command. Recording ends after 1.2 seconds of silence, 8 seconds without speech, or 30 seconds total. Only the command is transcribed and its text sent to Codex. The detector runs locally and pauses when muted, speaking, processing a request, or using push-to-talk. **Wake Now** also starts one command; **Sleep Now** discards it. Select the correct input microphone in Settings. Room noise can affect detection and silence timing.
