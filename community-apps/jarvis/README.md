# JARVIS Mark 55 for Open Quake

This app contains the supplied Mark LV (55) Python release by FatihMakes, plus an Open Quake launcher and dashboard compatibility adapter. Upstream attribution and license are in `Mark-LV/readme.md` and `Mark-LV/LICENSE`.

## Install

1. Import `community-apps/jarvis.zip` into Open Quake, or use this app folder as your drop-in app.
2. In the installed app folder, run `python install_mark55.py` with Python 3.11 or newer. This creates `Mark-LV/.venv`, installs the release dependencies and Playwright Chromium. Run it again after moving/importing the app; virtual environments are not portable.
3. Set the Gemini API key and pairing PIN in the JARVIS app options. Open the JARVIS panel. The launcher waits for the Mark 55 dashboard before pairing.

The new engine uses Gemini Live. Ollama/OpenAI provider settings from the previous binary are not supported by the supplied Mark 55 release. The desktop HUD opens alongside the Quake panel; its avatar/video display remains in the desktop window.

## Connection modes

The integrated `quake_main.py` launcher serves HTTP only on `127.0.0.1:8000`, accepts the configured Quake PIN, and supports panel chat, microphone audio, file upload, metrics, mute and showing the desktop window. It does not change firewall rules. Its Remote tab explains that this is local mode.

For the upstream phone/LAN dashboard, stop the integrated instance and run `Mark-LV/.venv/Scripts/python.exe Mark-LV/main.py` on Windows (use `.venv/bin/python` on macOS/Linux). Use Remote Control in the desktop HUD for a temporary pairing key. This separate mode uses the upstream HTTPS and network setup; it does not provide the Quake-specific endpoints.

Existing Mark 46 files remain as a rollback copy in the repository, but are not launched or included in the new ZIP. Personal configuration and memory are not copied automatically from the old engine. The launcher preserves existing Mark 55 configuration and updates only the API key and Quake PIN supplied in app options.

## Verification and packaging

Run `python -m unittest discover -s community-apps/jarvis/tests -v` from the repository root with FastAPI, httpx, uvicorn and cryptography installed. Run `python community-apps/jarvis/package_mark55.py` to rebuild the import ZIP. The package excludes legacy binaries, virtual environments, credentials, caches, logs and runtime memory.

Startup errors appear in `Mark-LV/startup.log`. A valid Gemini key, audio devices and connected Quake hardware are required for a full live verification.
