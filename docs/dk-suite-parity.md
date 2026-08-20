# DK-Suite feature parity

What the commercial package advertises versus what open-quake ships. The comparison source is the
[DECOKEE Quake product page](https://www.decokee.com/products/decokee-quake-desktop-ai-assistant)
(as advertised 2026-08); the open-quake side is current `main` (v0.5.7). This is the running list of
what they have that we don't — update it when either side changes.

> open-quake is an independent community project, not affiliated with DECOKEE — see the
> [README disclaimer](../README.md). Feature names in the "theirs" column are their marketing terms.

## ✅ Have (or have more)

| DK-Suite advertises | open-quake |
|---|---|
| AI Chat (credit-metered, 100 credits/mo free) | **Four AI apps, no credits**: real **Claude Code / Codex / Copilot agent sessions** (tools, approvals, your existing plan) + **Open WebUI** chat against your own models. *(In flight: one consolidated "AI Voice" app adding any OpenAI-compatible API by key.)* |
| Voice commands (press-and-speak) | Knob **hold-to-talk** everywhere + tap-to-toggle conversations; your own local Whisper STT (tts-sst), no cloud dependency. |
| AI Meeting Assistant (record → transcribe → summarize) | Meeting app: stereo-split recording, auto start/stop, **speaker-diarized transcripts** (self-hosted), attendee-guided speaker ID via Outlook calendar, AI notes (summary/decisions/actions), per-meeting filing, **Joplin export**. Materially deeper than the advertised feature. |
| Translation (Silver+ paid tiers) | **Live Translate**: word-by-word streaming captions (Soniox, ~$0.18/hr) or bring-your-own AI key (DeepSeek ≈ $0.10/hr, OpenAI, OpenRouter, LiteLLM/Ollama) with cross-sentence context, save-to-file, global hotkey. Not tier-gated. |
| Instant answers | Any of the AI apps; hold the knob and ask. |
| Drag-and-drop customization / preset app shortcuts | The PC-side editor: tile grids, merged tiles, per-page apps/dashboards, drag-and-drop, hotkeys. |
| Music player | Music controller: now-playing, transport, app grid, lyrics. |
| Smart home hub (use-case example) | First-class **Home Assistant integration**: entity tiles, real dashboards, MDI icons. |
| Stock dashboard / expense automation / 3D-printer control (use-case examples) | Web-dashboard pages + shell/macro tiles + HA cover the same ground generically. |
| LED ring status for recording/translation/AI states | RGB ring is theme-driven and state-driven (listening/thinking/speaking/approval), fully configurable. |
| Knob + touchscreen + gestures | Full knob support (rotate/click/double/hold), touch, page selector. |
| Credit packs / subscriptions | Nothing metered. Costs are only what your own keys/servers cost. |

## ❌ Missing (the actual todo)

| Feature | What they advertise | Lift for open-quake |
|---|---|---|
| **macOS / Linux support** | Multi-OS: Windows, macOS, Linux | **Large.** The launcher/editor are Electron (portable), but launch/volume/media/loopback-audio/reserved-display code is Windows-specific (README already flags this). Realistic only as a scoped "panel + apps, minus Windows-only extras" port. |
| **AI-generated wallpapers** | "Wallpaper Generation by AI" + random wallpaper rotation | **Medium.** OQ has no wallpaper concept — pages are functional. Would be a new "ambient page" type + an image-gen backend (user's own key, same BYO pattern). Questionable value; the panel is usually showing something useful. |
| **Smart Profiles (9 modes via knob)** | Knob-switchable AI modes (writing, coding, translation, research…) | **Small, mostly framing.** Multiple AI pages with per-page backend/model/prompt + page hotkeys already do this; what's missing is a packaged "profile" concept (per-page system prompt + a polished quick-switch). A per-page system-prompt option would close most of it. |
| **Game voice control** | Mentioned in their showcase | **Unclear scope.** Nearest OQ equivalents: global hotkeys, macros, LucidType. Needs a real definition of what theirs does before it's worth chasing. |

## Notes

- Their "no cloud subscription required / open-source engine" claim still routes AI through their
  credit system; open-quake's equivalent stance is stronger in practice (your CLIs, your servers,
  your keys).
- Hardware-only items (chassis, stand, transparent window, HDMI/USB wiring) are out of scope — both
  sides run the same device.
