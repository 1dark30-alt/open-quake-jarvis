# DK-Suite feature parity

What the commercial package advertises versus what open-quake ships. Comparison sources: the
[DECOKEE Quake product page](https://www.decokee.com/products/decokee-quake-desktop-ai-assistant)
plus their [Kickstarter](https://www.kickstarter.com/projects/decokee/decokee-quake-the-ultimate-desktop-ai-copilot)
and [AI-copilot](https://www.decokee.com/pages/quake-ai-copilot) pages (as advertised 2026-08),
cross-checked against a teardown of the installed DK-Suite (v0.4.69, unpacked Electron); the
open-quake side is current `main` (v0.5.7). This is the running list of what they have that we
don't — update it when either side changes.

> open-quake is an independent community project, not affiliated with DECOKEE — see the
> [README disclaimer](../README.md). Feature names in the "theirs" column are their marketing terms.

## ✅ Have (or have more)

| DK-Suite advertises | open-quake |
|---|---|
| AI Chat (credit-metered, 100 credits/mo free) | One **AI Voice** app, five backends, **no credits**: real **Claude Code / Codex / Copilot agent sessions** (tools, approvals, your existing plan), **Open WebUI** chat against your own models, or **any OpenAI-compatible API by key** (OpenAI, DeepSeek, OpenRouter, LiteLLM/Ollama). |
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
| 9 Smart Profiles (knob-switchable "modes") | Teardown: their 9 "profiles" are **page layouts** (Discord/MeetAI/SysView/AI Chat/Music/Clock/…) — already open-quake **pages** with the knob selector and per-page hotkeys. The real feature inside their AI Chat — named prompt modes (theirs: 6, Chinese-only) — **shipped as AI Profiles** (PR #23): 9 editable English instruction presets on all five AI Voice backends, switchable from the panel's Profile button / knob twist / per page, plus next/previous-page tile actions. |

## 🔨 In development

| Feature | Status |
|---|---|
| **Screensaver page — wallpapers incl. AI-generated** (teardown: their wallpaper feature, the "Vivid" profile, is a manual crossfading image/video page — no idle detection) | In progress on branch `screensaver`: a media slideshow page (drop images/videos in a folder — your own ComfyUI/AI renders go straight in, no credits) plus built-in animated scenes (color waves, starfield, code rain, big clock), and it **auto-starts when the panel sits idle and wakes back to where you were** — which theirs can't do. |

## ❌ Missing (the actual todo)

| Feature | What they advertise | Lift for open-quake |
|---|---|---|
| **macOS / Linux support** | Multi-OS: Windows, macOS, Linux | **Large.** The launcher/editor are Electron (portable), but launch/volume/media/loopback-audio/reserved-display code is Windows-specific (README already flags this). Realistic only as a scoped "panel + apps, minus Windows-only extras" port. |
| **AI-generated shortcut panels** | Hold the knob and say e.g. "create a shortcut set for Photoshop masking" — the AI generates a custom control set for that application, no manual macro programming (Kickstarter/copilot pages) | **Medium — and a natural fit.** OQ already has the two halves: AI routing (CLI agents / OWUI / any endpoint, no credits) and pages-as-JSON tile grids with `key`-type shortcut tiles. The missing piece is a "Generate panel with AI" flow in the editor (and/or by voice on the panel): prompt → validated tile JSON → new page for review. Probably the highest-value item on this list. |
| **Game voice control** | Mentioned in their showcase | **Unclear scope.** Nearest OQ equivalents: global hotkeys, macros, LucidType. Needs a real definition of what theirs does before it's worth chasing. |

## Notes

- Their "no cloud subscription required / open-source engine" claim still routes AI through their
  credit system; open-quake's equivalent stance is stronger in practice (your CLIs, your servers,
  your keys).
- Hardware-only items (chassis, stand, transparent window, HDMI/USB wiring) are out of scope — both
  sides run the same device.
