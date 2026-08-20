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
- **My media** — your own photos (jpg/png/gif/webp) and videos (mp4/webm/mov), kept in **two
  separate folders**, with a **Media** pick of *Photos + videos*, *Photos only*, or *Videos
  only*. Photos show in one of two styles: a crossfading **slideshow** (a photo per interval,
  cropped to fill or letterboxed) or a **collage** — prints drop in every 0.5–1.5s, tilted with
  white borders, until the screen is full; the finished board then holds for the interval before
  a fresh one starts. Videos always play through full-screen, muted, never cropped (and only in
  slideshow style). Shuffle optional.
- **Both** — scenes and media mixed into one rotation.

### The photos and videos folders

The app ships with its own empty `screensaver-media\photos` and `screensaver-media\videos`
folders (created under the app's data directory). In the editor, each folder row has **Open …
folder** — drop files into the Explorer window that opens and they play — and **Browse…** to
point at any other folder instead; leaving a folder blank goes back to the app's own.

Both folders can also be changed from the panel itself: tap the screensaver, tap **⚙**, then
**Browse** next to Photos folder or Videos folder.

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
| Show | Built-in scenes / My media / Both |
| Scenes | One collapsed dropdown of independent toggles — Waves, Starfield, Lava lamp, Fireflies, Flurry, any mix (hidden for media-only pages) |
| Media | Photos + videos, Photos only, or Videos only |
| Image style | Slideshow (one at a time) or Collage (scrapbook pile) — videos only play in Slideshow |
| Photos | Crop to fill the screen, or don't crop (letterbox) — slideshow photos only; videos never crop |
| Change every (s) | Seconds per photo/scene; videos play through; a finished collage board displays for this long |
| Shuffle | Randomize the order — the checkbox text names what it shuffles (scenes, media, or both) per the Show setting |
| Idle auto-start | Minutes of no input before auto-start; 0 = never |
| Photos / Videos folder | Blank = the app's own per-kind folder; Browse…/Open buttons below each (shown when that kind is in play) |

Everything except the folder path can also be changed on the panel: tap → **⚙**.
