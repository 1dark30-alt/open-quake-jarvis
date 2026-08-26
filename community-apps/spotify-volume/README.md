# Spotify Volume (`spotify-volume`)

Puts the panel's **knob in charge of one app's Windows volume** — Spotify by
default, configurable to any process. Turn the knob to adjust just that app's
audio session, independent of system volume.

By **J Last**.

## Options

- **Target process name** — the process whose audio session to control
  (default `Spotify`; e.g. `chrome`, `vlc`, `Discord`).

## Notes

- Uses a bundled native helper against the Windows **Core Audio session
  APIs** — no admin rights, no Spotify login or Premium, no Web API.
- The target app must have an active audio session (i.e. be playing or have
  played sound) before its volume can be adjusted.
- Windows-only by nature.
