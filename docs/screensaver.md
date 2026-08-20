# Screensaver

A screensaver page for the panel: built-in animated scenes or your own media, with optional
idle auto-start that returns you to exactly where you were.

## Adding it

In the editor, add an **App** page and pick **Screensaver**. That's it — the built-in scenes work
immediately, nothing to download or configure.

## What it shows

- **Built-in scenes** (default) — four animations drawn live by the page (no media files, nothing
  visibly loops): **Aurora** (drifting color ribbons), **Starfield**, **Code Rain**, and a big
  **Clock**. Show all four in a cycle or pin one.
- **My media folder** — a crossfading slideshow of your own images (jpg/png/gif/webp) and videos
  (mp4/webm/mov). Images change on the interval you pick; videos always play through to the end,
  muted. Fill the screen (crop) or fit inside (letterbox); shuffle optional.
- **Both** — scenes and media mixed into one playlist.

### The media folder

The app ships with its own empty `screensaver-media` folder (created under the app's data
directory). In the editor, the page's options have **Open media folder** — drop files into the
Explorer window that opens and they play. **Browse…** points the page at any other folder
instead; leaving the folder blank goes back to the app's own.

The folder can also be changed from the panel itself: tap the screensaver, tap **⚙**, then
**Browse** next to Media folder.

## Idle auto-start

One setting controls it: **Auto-start after idle minutes** (default **10**, **0 = never**).
After that long with no panel touches and no knob turns, the panel switches to the screensaver
by itself. Any touch or knob input wakes it — you land back on exactly the page you left, with
nothing reloaded, and the waking gesture is swallowed so it can't press anything on that page
(no accidental mic toggles or page flips).

Sensible guards, all automatic:

- Auto-start only runs in **panel mode** (in software/monitor mode Windows has its own screensaver).
- It stays away while a **voice conversation** is live or a **meeting is being recorded**.
- Page **auto-rotation pauses** while the screensaver is up and resumes on wake.
- If a page hotkey or focus-follow switches the page while the screensaver is up, the screensaver
  simply steps aside.
- A relaunch while the screensaver is up boots back to your real page, never into the screensaver.

The page is also a normal page: select it with the knob or include it in auto-rotation — visited
that way it never swallows input (a tap just advances to the next scene/photo and briefly shows
the ⚙ settings button).

## Options (editor → the page's App options)

| Option | Meaning |
|---|---|
| What to show | Built-in scenes / My media folder / Both |
| Built-in scene | All scenes (cycle) or one of Aurora, Starfield, Code rain, Clock |
| Media fill | Fill the screen (crop) or fit inside (letterbox) |
| Seconds per image/scene | Slideshow interval (videos always play through) |
| Shuffle order | Randomize the playlist |
| Auto-start after idle minutes | 0 = never; otherwise the idle time before auto-start |
| Media folder | Blank = the app's own folder; Browse…/Open media folder buttons below |

Everything except the folder path can also be changed on the panel: tap → **⚙**.
