# Licenses

The app itself (`app.js`, `server.js`, `style.css`, `index.html`, `app.json`,
`vendor-parchment.js`) is MIT, same as open-quake.

## Bundled third-party code

`interpreter/parchment-single.html` is the **single-file build of Parchment**, the
interactive-fiction web interpreter, taken unmodified from an upstream release except for one
documented patch (see below).

| Component | Upstream | License |
| --- | --- | --- |
| Parchment | [curiousdannii/parchment](https://github.com/curiousdannii/parchment) | MIT |
| AsyncGlk | [curiousdannii/asyncglk](https://github.com/curiousdannii/asyncglk) | MIT |
| Emglken | [curiousdannii/emglken](https://github.com/curiousdannii/emglken) | MIT |
| RemGlk-rs | [curiousdannii/remglk-rs](https://github.com/curiousdannii/remglk-rs) | MIT |
| Bocfel (Z-machine) | [garglk/garglk](https://github.com/garglk/garglk) | MIT |
| Glulxe (Glulx) | [erkyrath/glulxe](https://github.com/erkyrath/glulxe) | MIT |
| Git (Glulx) | [DavidKinder/Git](https://github.com/DavidKinder/Git) | MIT |
| Hugo | [hugoif/hugo-unix](https://github.com/hugoif/hugo-unix) | BSD-2-Clause |
| jQuery | [jquery/jquery](https://github.com/jquery/jquery) | MIT |
| Iosevka (font) | [be5invis/Iosevka](https://github.com/be5invis/Iosevka) | OFL |

Parchment's full component list is in its
[README](https://github.com/curiousdannii/parchment#readme). Two of the interpreters it can
bundle — Scare (Adrift) and TADS — are GPL-2.0; they are **not** part of this build.

`wyoming.js` and `vad.js` are vendored copies of open-quake's own
`app/claudevoice-wyoming.js` and `app/claudevoice-vad.js` (MIT). Drop-in apps live in the
user-data folder and cannot require platform modules, so the app carries its own copies.

## The one patch, and how to upgrade

Parchment's `load()` does `if (embedded && !options.play_in_iframe) { window.open(...); return }`
— an embedded copy opens a new browser tab instead of playing in place. `play_in_iframe` is not
one of the query-overridable options, and the single-file build hardcodes its options inline, so
that flag has to be set in the literal.

`vendor-parchment.js` applies exactly that change and nothing else:

```bash
node vendor-parchment.js /path/to/parchment.html
```

Download `parchment-single-file-*.zip` from
[Parchment's releases](https://github.com/curiousdannii/parchment/releases), unzip it, and run the
script against the `parchment.html` inside. It refuses to write if the options literal it patches
is no longer there, so a breaking upstream change is caught rather than silently mis-applied.

Current bundled version: **Parchment 2026.8.1**.

## Story files

None are bundled. Works of interactive fiction are copyrighted by their authors — Infocom titles
such as Zork are not free to redistribute. See `stories/README.txt`.
