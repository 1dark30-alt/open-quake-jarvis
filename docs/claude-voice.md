# Claude Code — voice + text panel app

A bundled **Claude Code** app puts a real, full-fidelity `claude` CLI session on the panel: type
or talk to it, watch replies stream in as text, copy exact commands out with a real cursor
selection, and approve or deny anything it wants to do — all from the touchscreen. Add it from the
editor via **+ App → Claude Code**.

This is the same kind of session you'd get from a terminal — same CLAUDE.md, same tools, same
subscription auth (no API billing: it runs the plain `claude` CLI, no `--bare`, no
`ANTHROPIC_API_KEY`). The panel doesn't attach to an existing terminal session or share one live —
it starts and owns its own session, entirely on the device. Copy-pasting a command it suggests out
to a terminal elsewhere is the expected way to actually *run* something outside the project it's
working in.

## Setup

In the editor, open the **Claude Code** app page and fill in:

| Field | What to enter |
|---|---|
| **Project directory** | pick from the dropdown (scanned from **Projects folder**) or type a new path |
| **Projects folder (for the picker)** | the parent folder to scan, e.g. `D:\Github` |
| **Wyoming host (STT/TTS)** | your `wyoming-faster-whisper` / `wyoming-piper` host |
| **Wyoming STT port** / **TTS port** | default `10300` / `10200` |
| **Permission mode** | same meaning as `claude --permission-mode` — see below |
| **Touch approval when in Manual mode** | see [Touch approvals](#touch-approvals) |

Picking a new (not-yet-existing) project directory creates it on first use.

### Permission mode

This is **your call, per session** — open-quake doesn't decide it for you, same as running
`claude` from a terminal:

- **Manual** — ask before every action. Pair with **Touch approval** to approve/deny from the
  panel instead of a terminal prompt.
- **Accept edits** — file changes are auto-approved.
- **Plan** — Claude describes what it would do without acting, until told to proceed.
- **Full auto (bypassPermissions)** — no prompts at all. Useful for quick, low-stakes sessions;
  use with the same care you would in a terminal.

## Voice — tap the knob to start/stop talking

**One tap opens a continuous conversation; a second tap closes it.** Unlike the Open WebUI
[chat app](ai-chat.md)'s hold-to-talk, this doesn't require holding anything down — speak whenever
you like while the conversation is open, the same way voice mode works in the Claude mobile app.
Utterance boundaries are detected automatically (a short pause ends the current utterance and
sends it); there's no separate "stop talking" gesture.

Requires the page's **Knob → Override → Click** set to **Enter** (Settings → page → Advanced —
the same one-time setup Music's play/pause uses).

**Text works at the same time, always.** The message box is never disabled by voice mode — type
mid-conversation whenever a command or variable name is easier to get exactly right by typing than
by saying it out loud, or when you'd rather read Claude's reply than have it spoken. A typed
message never triggers an unsolicited spoken reply; only a voice-started turn gets spoken back.

The transcript is real, selectable text — click-drag and Ctrl+C work like any normal page. Fenced
code blocks also get a one-tap **Copy** button.

### Ring feedback

The knob's RGB ring mirrors the on-screen status text, so you don't have to be looking at the
screen to know what's happening:

| State | Ring |
|---|---|
| Idle | your normal configured ring |
| Listening | solid green |
| Thinking | breathing green |
| Speaking | solid blue |
| Awaiting your approval | breathing amber |

The ring reverts to your normal theme-driven setting the moment you leave the Claude Code page, or
whenever the conversation goes back to idle.

## Touch approvals

With **Permission mode = Manual** and **Touch approval** turned on, anything Claude wants to do
(run a command, write a file, etc.) shows a full-screen overlay on the panel with the exact tool
and its input — never truncated — and two large **Approve** / **Deny** buttons.

### How it works, and why it's safe for your terminal sessions too

Turning this on registers a **global** hook in `~/.claude/settings.json` — the one settings file
every Claude Code session on this machine reads, in any project, terminal or otherwise. That
sounds broad, but the hook itself only does anything when **both** are true:

1. It's running inside a session this panel started (checked via an environment variable only the
   panel's own session sets — a normal terminal `claude` session never has it).
2. That session's permission mode is **Manual**.

Everywhere else — any terminal, any project, any other permission mode — the hook is a complete,
instant no-op. It does not change how normal `claude` usage behaves anywhere on this machine.

The install/removal is idempotent and additive: it only ever adds or removes its own entry, and
never touches any other hook you've registered yourself. The settings file is backed up
(timestamped, alongside the original) before any write, since it isn't tracked by this repo's git
history. Toggling the checkbox takes effect the next time a Claude Code session starts on the
panel — not instantly for a session already running.

If the panel is unreachable or doesn't respond in time, the request **fails closed** (denied) —
never an unattended auto-allow.

## Wyoming STT/TTS

Speech-to-text and text-to-speech run against **your own** [Wyoming](https://github.com/rhasspy/wyoming)
services (`wyoming-faster-whisper`, `wyoming-piper`) — not a cloud API, not Open WebUI. Audio sent
for transcription is 16kHz/16-bit/mono PCM; the reply's playback format is always read from the
server live rather than assumed, since Piper's sample rate varies by voice model.

## How it works

Like the [chat app](ai-chat.md), this is a **served** app — the page loads from
`http://127.0.0.1:<port>/claude-voice`, which is what makes `getUserMedia` (the mic) work over
plain HTTP as a secure context. The panel's main process owns one persistent `claude` CLI process
per session (spawned with `--input-format stream-json --output-format stream-json`), streams its
replies to the page over Server-Sent Events as they're generated, and proxies STT/TTS through your
Wyoming host over a small hand-rolled TCP client (no npm dependency — no maintained JS Wyoming
client exists).

## Troubleshooting

- **"claude CLI not found on PATH"** — install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)
  and make sure `claude` resolves from a normal terminal first.
- **Turn fails immediately, no reply** — no project directory set, or the CLI isn't authenticated
  (run `claude` once from a terminal to complete OAuth login).
- **Voice does nothing on tap** — check the page's Knob → Override → Click is set to **Enter**,
  and that the device mic is on (tray → mic).
- **No transcription / no speech playback** — check the Wyoming host/port fields; confirm
  `wyoming-faster-whisper`/`wyoming-piper` are reachable from this machine.
- **Approvals never show up on the panel** — Permission mode must be **Manual** *and* Touch
  approval must be on; toggling either one only takes effect for the *next* session you start.
- **Security note** — nothing in this app stores a credential: Claude auth is your existing OAuth
  session (same as a terminal), and Wyoming has no auth of its own. The one secret involved is a
  random per-launch token used only to let the approval hook prove its requests are legitimate to
  the panel's local server — it's never written to disk.
