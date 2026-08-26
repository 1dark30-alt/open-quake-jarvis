# JARVIS (`jarvis`)

Voice-assistant client for the panel: pairs with a **JARVIS server** over a
PIN, then holds spoken conversations backed by your choice of LLM — **Gemini
Live**, a local **Ollama**, or any **OpenAI-compatible endpoint**.

## Setup

1. **JARVIS Server URL** — where your JARVIS server runs (default
   `http://127.0.0.1:8000`).
2. **Pairing PIN** — must match the PIN configured on the server (stored as a
   secret).
3. **LLM Provider** — Gemini Live (needs the **Gemini API Key** option), or
   Ollama / OpenAI-compatible (set **Base URL** and **Model Name**).
4. **OS Target** — the operating system the server acts on (Windows / macOS /
   Linux).

## Notes

- The PIN and Gemini API key are stored as encrypted secrets and stay
  server-side.
- The panel is the client only; the JARVIS server is a separate program you run
  yourself.
