# Interactive Fiction (`if-player`)

Play **Inform / Z-machine and Glulx text adventures** on the panel, with the
story **read aloud** through your TTS voice and **spoken commands** transcribed
by your STT — both picked up automatically from Settings → TTS/STT. Keyboard
play works normally too. Bundles the
[Parchment](https://github.com/curiousdannii/parchment) interpreter (MIT — see
`LICENSES.md`).

## Setup

- **Stories folder** — any folder on the PC holding `.z5 / .z8 / .zblorb /
  .ulx / .gblorb` files; every story inside appears in the on-screen list.
  Blank = the app's bundled stories folder.
- **Saves folder** — where save files are written (one subfolder per story).
  Saves are real files kept outside the app, so they survive updates and
  reinstalls. Blank = a `saves` folder next to your stories.
- **Read the story aloud** / **Voice commands** — toggle TTS narration and the
  Listen control; both can also be toggled on screen.
- **Auto-save** — optionally save progress every N minutes (off by default).
- **Auto-start story** — optional filename to open straight into.

## Notes

- Advanced per-app overrides for the Wyoming TTS/STT host and port live under
  the app's own settings; blank means the system servers from Settings →
  TTS/STT.
- Story files are copyrighted works — bring your own or use freely licensed
  titles (the IF Archive is a good source).
