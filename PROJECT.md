# PROJECT — Meeting recording (Phase 1)

Turns the **Meeting** app from a stateless Zoom/Teams remote control into a meeting
*recorder*. It captures your microphone and the system (speaker) audio, merges them into
one stereo WAV per meeting (you = left channel, everyone else = right), and can start on
its own the moment a real call begins. Phase 1 is recording only; a later phase adds the
transcription/analysis pipeline.

## Charter

**1. What is the one thing this must do?**
Record a meeting — your mic (left) + everyone else's system audio (right) — to a playable
file in a chosen folder, started manually from the panel **and** automatically when a real
Zoom/Teams call begins.

**2. What would be wrong if we shipped "working" software without it?**
- **Both channels must actually be captured.** A file that's silent on the mic or the
  system side is a failed recording. Mic = left, system = right, both non-zero.
- **Auto-record must be app-scoped.** It must start for Zoom/Teams calls and NEVER for a
  Claude-voice session or other incidental mic use. A sound/VAD trigger can't tell these
  apart, so this is non-negotiably driven by *which app* holds an active capture session.
- **Background recording must not depend on the meeting page being on-screen.** The panel
  is one WebView that navigates between apps; recording has to keep running when the panel
  shows something else.

**3. What is explicitly off-limits as a workaround?**
- No recording all microphone use indiscriminately (would capture Claude sessions).
- No requiring the meeting page to be focused/open to record in the background.
- No VAD/sound-level "mic is active" trigger standing in for real app-scoped detection.
- No capping capture below the agreed 16 kHz stereo.

**4. Deployment target and backup location?**
- Target: bundled into **open-quake** (Windows desktop, Electron kiosk).
- Backup: the git repo, `meeting-dev` branch — commits are the backup.

**5. How will we verify it's done?**
- Manual: Meeting app → Record (split opens) → Start → play audio + talk → Stop → a WAV
  named `YYYY-MM-DD-HH-MM-SS.wav` appears in the meeting folder with both channels non-zero.
- Auto: with auto-record on, starting a real Zoom (and Teams) call auto-starts recording
  even with the panel on another app; ending the call / going silent auto-stops.
- Negative: starting a Claude-voice session does **not** begin a recording.
- Mic: the mic picked in the editor is the panel's default; changing it on the panel
  applies live. Split UI reads correctly on the 1920×480 panel in light and dark.

## Architecture (as built)

- **Hidden recorder window** (`app/meetingRecorder.js` + `app/recorderview.*`,
  `app/recorder-preload.js`): a main-owned `show:false` BrowserWindow on its **own**
  `persist:recorder` session partition — the loopback display-media handler
  (`app/loopback-audio.js`) is registered only there, never on the shared dashboards
  session. It is the single audio-capture path; `app/system-audio-capture.js` merges mic +
  system loopback into interleaved stereo int16 PCM and streams it to main, which writes a
  16 kHz stereo WAV.
- **Native app-scoped trigger** (`native/mic-session-monitor.cs` → `app/native/
  mic-session-monitor.exe`, built by `build-smtc.js`): a WASAPI audio-session poller that
  reports when an allowlisted process (default `Zoom.exe`, `Teams.exe`, `ms-teams.exe`)
  holds an *active* capture session. main spawns it and auto-starts/stops on its signal.
- **Panel** (`app/meetingview.*`): UI/remote only. A right-aligned **Record** button in the
  top row toggles a split — action cards collapse to the top half, recording controls fill
  the bottom half; the zone also opens automatically whenever a recording is live. It polls
  `/meeting-state` and drives start/stop/mic over HTTP (`app/sysserver.js`). No capture here.
- **Settings** (`app/config.js`, Meeting tab): stored under `config.settings.meeting`
  (folder, mic label, auto-record, call-app allowlist, silence-stop minutes, echo gate) —
  global, so auto-record works regardless of the active app.

## Known follow-ups (later phases)
- Transcription / diarization / analysis pipeline over the recorded WAVs.
- macOS support (loopback = ScreenCaptureKit perms; the native monitor is Windows-only).
- Optional AudioWorklet capture path (current uses ScriptProcessorNode — deprecated but fine).
