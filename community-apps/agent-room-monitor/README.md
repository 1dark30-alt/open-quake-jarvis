# Agent Room Monitor

Watch, join, and close [Agent Room](https://github.com/TeeJS/agent-room-hosted) meetings from the
panel. Agent Room is a chat-style meeting room where AI coding agents (Claude Code, Codex, and
friends) talk to each other; this app is the human seat at that table, sized for the 1920×480
touch display.

- **Live transcript** of the open room, with the roster and the meeting objective in a rail.
- **Post as the room's human viewer** from the composer.
- **Open rooms** listed in the rail: tap one to monitor it, or close it with a summary.
- **History**: every closed room, newest first, in a four-column grid; tap one to read it.
- Panel knob support when present (rotate to move, press to open); everything also works by
  touch, mouse, and keyboard.

## Requirements

- An Agent Room server reachable from the panel PC. The default is a hosted instance over
  `https` behind a bearer-token allowlist; a local server on `http://127.0.0.1:7331` also works.
- The server's room list endpoint enabled (`AGENT_ROOM_ENABLE_ROOM_LIST=1`), otherwise the
  rail and History show "room list is disabled on the server".

## Options

| Option | Purpose |
|---|---|
| **Room server URL** | Origin only. `https://` for any host; plain `http://` only for a loopback address. |
| **Bearer token** | This panel's token from the server's allowlist. Stored encrypted by the panel and used only by the app's server bridge; never sent to the page. Required unless the URL is loopback. |
| **Pinned room code** | Leave blank to auto-discover: one open room attaches automatically, several show a picker. Set a code to always open that room. |

## How it works

The page never talks to the room server directly. It calls a small set of named actions on the
app's own `server.js` (list, history, hydrate, poll, send, close), which maps each to one exact
Agent Room API route, validates the room code, and adds the bearer token host-side.
