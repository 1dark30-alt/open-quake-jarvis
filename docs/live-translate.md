# Live Translate

Real-time speech **translation captions on the panel**. Point the mic at a conversation, a film, or
a meeting and watch it translated into your language, live — word by word, as it's spoken, not after
a pause. Add a **Live Translate** page in the [editor](editor.md) and tap the mic (or the knob, or a
[hotkey](#hotkey)).

Translation is powered by **[Soniox](https://soniox.com)**, a cloud real-time speech-translation
service (~$0.18/hr while actively translating; there's a free trial credit).

## Setup

1. Sign up at [soniox.com](https://soniox.com) and create an API key.
2. In the Live Translate page's editor settings: paste the **API key** and set a
   **target language** (e.g. `en`, `es`, `de` — [browse codes](https://soniox.com/docs/stt/concepts/supported-languages)).
3. Optionally set a **source hint** (the language you expect) — it removes the couple-second warm-up
   Soniox otherwise spends auto-detecting the language.

Your real key never reaches the panel page: open-quake mints a short-lived **temporary key** and the
page authenticates with that. The key is stored encrypted at rest.

## Extras

- **Save to file** — toggle it on to write the translation to a text file; choose the folder in the
  editor (default `Documents\OpenQuake Translations`).
- **Microphone** — pick the capture device in the page's editor or the on-panel Settings.
- <a id="hotkey"></a>**Toggle hotkey** — set a global key combo in the editor that starts/stops
  translation from any app (it switches to the page and toggles the mic). The **knob** does the same
  when the page is on-screen.
