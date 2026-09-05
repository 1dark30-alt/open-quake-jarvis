# Stream Deck Host (`deck-host`)

Run **Elgato Stream Deck plugins on the panel** — no Stream Deck hardware, no
Elgato software. Point it at a folder of `*.sdPlugin` packages and it launches
them against Elgato's documented plugin protocol: the on-screen key grid shows
each plugin's live images and titles, taps press the keys, and the **knob
cycles profiles**.

It also imports `.streamDeckProfile` exports, with working implementations of
the Stream Deck **built-in keys**: Hotkey (real keystrokes via SendInput), Text
typing, Open (URL/file), Website, and folder navigation — so a profile built on
a real Stream Deck largely just works.

## Setup

1. Set **Plugins folder** to a folder on the PC containing your `*.sdPlugin`
   packages and any `*.streamDeckProfile` files (import via Profile → Import).
2. Pick **Key size**: 3 keys high (more keys) or 2 keys high (jumbo). Columns
   are computed from the screen automatically.

## Notes

- **Plugins are real programs that run on your PC** — only add plugins you
  trust.
- Scope today: Keypad actions from native/Node plugins. No property inspectors
  or dial/encoder actions yet.
- Elgato **Marketplace** downloads are encrypted (`ELGATO`-prefixed payloads)
  and can't run here; they're skipped and reported honestly. Plain open-source
  packages work.
- Protocol reimplemented per Elgato's public docs (approach per OpenDeck); no
  Elgato or OpenDeck code included.
