# System monitor (SystemView) — RETIRED

The System Monitor page was **retired in v0.5.2** and no longer functions.

Its metrics layer (the `systeminformation` package plus a GPU perf-counter query) spawned a
one-shot PowerShell process for nearly every reading — hundreds of process creations per
minute while the page was on screen. Endpoint-security tools reasonably flag that pattern as
malware-like behavior, so the whole collection layer was removed rather than throttled.

- New installs no longer get the page.
- An existing **System Monitor** page now shows a retirement notice instead of the dashboard;
  delete the page in the settings editor to remove the last trace.
- The `systeminformation` dependency was dropped entirely, so no code path can reintroduce
  the churn.

A rebuilt monitor may return in a future version using a single persistent native helper
(the same churn-free pattern the app's other helpers use) instead of per-query PowerShell.
