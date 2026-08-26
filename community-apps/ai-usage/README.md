# AI Usage

A single-glance usage monitor for the panel, covering three AI tools side by side:

| Panel | Source | What it shows | Setup |
| --- | --- | --- | --- |
| **Claude** (Code · Cowork) | Local Claude Code logs at `~/.claude/projects` | Estimated API-rate value, messages, sessions, tokens (in/out/cache), per-model split, 14-day spend | none |
| **ChatGPT** (Codex CLI) | Local Codex CLI logs at `~/.codex` | Weekly + 5-hour rate-limit gauges (read straight from the logs), messages, tokens, 14-day activity | none |
| **Copilot** | GitHub billing API | Premium requests used vs. your monthly quota, remaining, billed overage | GitHub username + token |

The period control (Today / 7 days / 30 days / All) rescopes the Claude and ChatGPT numbers.
The Codex and Copilot gauges are their own fixed windows (this week / this billing month).

## How it works

This is a **served drop-in with a host-side `server.js`**, so installing it shows the standard
"contains executable code" prompt — that code is what reads your local session logs. It runs in
the panel host process and returns only aggregated numbers to the page; **raw log contents and
your GitHub token never leave the host**. The first scan of a large history takes a few seconds,
then a cached per-file index makes refreshes near-instant.

> The Claude and ChatGPT figures reflect **CLI usage on this machine** (Claude Code / Cowork and
> the Codex CLI) — they can't see usage from the web apps, because those don't write local logs.
> The Claude "spend" is an **estimate** at first-party API rates, shown as the subscription value
> you're getting; it is not a bill.

## Options

| Option | Purpose |
| --- | --- |
| **GitHub username** | Your login — enables the Copilot panel. Leave blank to show a connect prompt. |
| **GitHub token** | Fine-grained PAT with **Plan** (read-only) permission. Server-side only; never sent to the page. Create at github.com/settings/personal-access-tokens. |
| **Copilot monthly quota** | Sets the gauge denominator (Pro 300 / Pro+ 1500 / Enterprise 1000). |
| **Claude / Codex data folder** | Advanced — override the default `~/.claude` / `~/.codex` locations. |
| **Refresh interval** | How often the panels re-scan and re-poll (15 s – 2 min). |

## Knob

Rotate to cycle the time period; single-press to refresh now.

## Requirements

- Claude panel: [Claude Code](https://claude.com/claude-code) session logs present on this machine.
- ChatGPT panel: the [Codex CLI](https://github.com/openai/codex) used on this machine.
- Copilot panel: a GitHub account with Copilot and a token with Plan read access.
