# VLC Desktop Remote (`vlc-remote`)

Touch remote for a **VLC media player** running on this PC or elsewhere on the
network: transport controls (play/pause/stop/next/previous), ±10s/±60s seeking,
volume, now-playing status with progress, and the playlist with search.

By **Mark Hollingworth**.

## Setup

1. In VLC: **Preferences → Main interfaces → check "Web"**, and set a password
   under **Main interfaces → Lua** (VLC requires one). Restart VLC.
2. In the app's options:
   - **VLC HTTP URL** — `http://127.0.0.1:8080` for VLC on this PC, or the
     other machine's address.
   - **VLC password** — the Lua password (stored as an encrypted secret).
   - **Refresh interval** — 1–30 s status/playlist polling (default 2 s).
   - **Demo data** — try the UI without a VLC connection.

## Notes

- All VLC requests go through the app's server module: the password never
  reaches the page, and errors are scrubbed of credentials.
- If the remote shows offline, verify the web interface is enabled and
  reachable (a browser to the VLC URL should prompt for the password).
