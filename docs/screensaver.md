# Screensaver

A screensaver page for the panel: built-in animated scenes or your own media, with optional
idle auto-start that returns you to exactly where you were.

## Adding it

In the editor, add an **App** page and pick **Screensaver**. That's it — the built-in scenes work
immediately, nothing to download or configure.

## What it shows

- **Built-in scenes** (default) — animations drawn live by the page (no media files, nothing
  visibly loops): **Waves** (drifting color ribbons), **Starfield**, **Lava lamp** (gooey
  molten blobs), **Fireflies** (glowing wanderers over a meadow), and **Flurry** (glowing
  smoke comets with cycling colors). Each scene is its own on/off toggle — the cycle plays
  whatever mix you leave on (the editor keeps the toggles behind one Scenes dropdown).
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
| Show | Built-in scenes / My media folder / Both |
| Scenes | One collapsed dropdown of independent toggles — Waves, Starfield, Lava lamp, Fireflies, Flurry, any mix (hidden for media-only pages) |
| Media fill | Fill the screen (crop) or fit inside (letterbox) — media sources only |
| Change every (s) | Seconds per image/scene (videos always play through) |
| Shuffle | Randomize the order — the checkbox text names what it shuffles (scenes, media, or both) per the Show setting |
| Idle auto-start | Minutes of no input before auto-start; 0 = never |
| Media folder | Blank = the app's own folder; Browse…/Open media folder buttons below (media sources only) |

Everything except the folder path can also be changed on the panel: tap → **⚙**.
