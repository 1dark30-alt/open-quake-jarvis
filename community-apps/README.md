# Community drop-in apps — downloads

Downloadable drop-in apps for open-quake. Grab an app's **`.zip`** below and import it with
**Settings → Drop-In Apps → Add (import .zip)**.

For how to install or submit an app — and a safety note — see the docs:
**[docs/community-apps.md](../docs/community-apps.md)**.

## Available apps

- **[if-player](if-player)** — play Inform / Z-machine text adventures (Z-code and Glulx),
  with the story **read aloud** through your TTS voice and **spoken commands** transcribed by
  your STT — both picked up automatically from Settings → TTS/STT. Keyboard play works
  normally; drop story files into the app's `stories/` folder. Bundles the
  [Parchment](https://github.com/curiousdannii/parchment) interpreter (MIT). Download
  [`if-player.zip`](if-player.zip) and import via **Settings → Drop-In Apps → Add**.
- **[jarvis](jarvis)** — JARVIS voice-assistant client: pairs with a JARVIS server over a
  PIN, and talks to Gemini Live, Ollama, or an OpenAI-compatible endpoint. Download
  [`jarvis.zip`](jarvis.zip) and import via **Settings → Drop-In Apps → Add**.
- **[kitten-cannon](kitten-cannon)** — a remake of the classic Kitten Cannon flash game,
  ported for the panel with touch controls: drag or hold the arrow buttons to aim, tap
  FIRE to launch, bounce off trampolines and TNT for distance. Optional shared
  high-score server (configurable Server URL; works fully offline too) and a
  persistent mute button. Download [`kitten-cannon.zip`](kitten-cannon.zip) and import
  via **Settings → Drop-In Apps → Add**.
- **[news-spotlight](news-spotlight)** — full-screen rotating RSS feed reader. Defaults
  to BBC / Sky / The Verge / Ars Technica; configurable feeds, story duration, Ken
  Burns motion, breaking-news mode, and an SSRF-safe proxy. Download
  [`news-spotlight.zip`](news-spotlight.zip) and import via
  **Settings → Drop-In Apps → Add**.
- **[quake-bird](quake-bird)** — a flappy-style arcade game: tap to flap, thread the pipe
  gaps, chase your best score. Original canvas artwork; pipes follow your accent color and
  the page theme. Optional shared high scores on the same score server as kitten-cannon
  (player initials + configurable Server URL; fully playable offline). Download
  [`quake-bird.zip`](quake-bird.zip) and import via **Settings → Drop-In Apps → Add**.
- **[spotify-volume](spotify-volume)** — per-app Windows volume control for the knob (Spotify
  by default, configurable to any process). Uses a bundled native helper against the Core
  Audio session APIs — no admin, no Spotify login/Premium, no Web API. By **J Last**.
  Download [`spotify-volume.zip`](spotify-volume.zip) and import via
  **Settings → Drop-In Apps → Add**.

To add one, open a pull request — see
[docs/community-apps.md](../docs/community-apps.md#submitting-one).

## Shared high scores for your game

Want online leaderboards in your community game? A free hosted score server is available
to all community apps — kitten-cannon and quake-bird already use it, and you're welcome
to as well. See **[SCORE-API.md](SCORE-API.md)** for the URL (use of it in community
games is explicitly permitted), the game-slug and 3-letter-initials conventions, and the
endpoint reference. Self-hosting instructions are linked there too.

## For developers

Building your own drop-in app? The [`skills/`](skills) folder holds
Claude Code skills you can drop into your `.claude/skills/` to get
AI-assisted scaffolding and authoring help. Today:

- [`open-quake-drop-in-app`](skills/open-quake-drop-in-app) — guides
  Claude through the manifest schema, served vs. file modes, options,
  `/app-proxy`, `/app-api`, and the host/runtime boundary so it stays
  inside `apps/<app-id>/` and doesn't touch platform code.
