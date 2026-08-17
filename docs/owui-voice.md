# Open WebUI Voice — voice + text panel app

A bundled **Open WebUI Voice** app puts a streaming chat against your own
[Open WebUI](https://openwebui.com) server on the panel, the same way the
[Claude Code](claude-voice.md), [Codex](codex-voice.md), and [Copilot](copilot-voice.md) apps do
for their agents: type or talk to it, watch replies stream in, copy text out with real cursor
selection, and pick models from the touchscreen. Add it from the editor via **+ App → Open WebUI
Voice**. All four apps share one page, one voice pipeline, and one design — only the agent behind
them differs.

Unlike the other three there is no CLI: the app talks to Open WebUI's OpenAI-compatible HTTP API
(`/api/chat/completions`) directly, so your local models answer with nothing else installed. The
conversation is multi-turn — the app keeps the recent history (about 40 messages) as context, a
step up from the single-shot [Open WebUI chat widget](ai-chat.md).

## Setup

1. In the editor, open **Settings → Auth → Open WebUI** and enter the server **URL**, an
   **API key**, and a **Default model**, then click **Test connection** — it reports the live
   model count or a clear error. (In Open WebUI: avatar → Settings → Account → API Keys; an admin
   may need to enable API keys first.) This one connection is shared with the meeting
   [Analysis AI](meeting.md).
2. Add the **Open WebUI Voice** app to a page. The options match the other agent apps' voice
   fields (Wyoming STT/TTS host and ports, chat text size); the model can be overridden per page
   from the panel's Settings.

If no URL is configured yet, the editor warns on the app page the moment you select it.

## What's different from the agent apps

- **No Mode button and no approvals** — a chat completion API can't touch files or run commands,
  so there is nothing to approve and no permission modes to pick.
- **No working folder** — sessions have no project directory; the folder button does nothing.
- **Truncation is visible, not fatal** — if a reply hits the model's context limit, the partial
  text stays on screen and the status line notes it was truncated.

## Models

The Settings **Model** row lists what your server reports from `/api/models`, with **Default**
(the Auth tab's default model) always available. Switches apply from the next message.

## Troubleshooting

Error wordings name the fix:

- *"Open WebUI connection not configured — set the URL on the editor's Auth tab."* — no URL saved.
- *"Open WebUI rejected the API key … check the key on the Auth tab"* — the key is wrong,
  revoked, or API keys are disabled server-side.
- *"could not reach Open WebUI … is Open WebUI running?"* — the server is down or the URL/port
  is wrong. **Test connection** on the Auth tab gives the same diagnosis live.
- *"no Open WebUI model set …"* — pick a model with the panel's Model button or set a default on
  the Auth tab.
