# Unraid Manager

Monitor and manage several Unraid servers from the panel. **Docker-first** — built to stay
usable with 60+ containers — plus array/disks/parity, UPS, VMs, and notifications.

## Requirements

- **Unraid 7.2 or newer** on each server (the GraphQL API is built into the OS; no Connect
  plugin needed). Verified field set targets 7.3.x.
- An **API key** per server.

## Setup

1. On the Unraid server, create an API key with the **admin** role (needed for start/stop/update):
   - Web UI: **Settings → Management Access → API → API Keys → Create** (role: admin), or
   - CLI: `unraid-api apikey --create`
2. In the panel, open this app's **App options** and fill a server slot:
   - **Server N URL** — the webGUI address, e.g. `http://192.168.1.25` (do **not** add `/graphql`).
   - **Server N API key** — the key from step 1.
   - **Server N name** — the label shown in the left rail.
3. Repeat for up to 4 servers. Leave a slot's URL blank to hide it.

Options:
- **Server N stats-api URL** — optional; enables GPU + per-container CPU/mem/VRAM (see below).
- **Verify HTTPS certificate** — uncheck only if a URL is `https` with a self-signed cert.
- **Allow container controls** — turn off for a read-only (monitoring-only) panel.
- **Refresh interval** — 5 / 10 / 30 s.

## GPU + per-container CPU/memory (optional stats-api add-on)

The Unraid GraphQL API does not expose GPU stats or per-container CPU/memory. To
get them, run the tiny **stats-api** add-on (github.com/TeeJS/stats) on that
server — it serves host GPU + per-container CPU/mem/VRAM as JSON on port 19998 —
and put its URL (e.g. `http://192.168.1.25:19998`) in that server's **stats-api
URL** option. The panel then shows a live GPU card on Overview, a GPU chip up
top, and CPU%/memory on each Docker row. Leave the option blank and those simply
fall back to their honest "no data" state. The add-on is unauthenticated, so keep
it LAN-only.

The API key is stored encrypted at rest and used only server-side (never placed in a URL or sent
to the browser); all Unraid calls happen in the host, so there is no CORS/Extra-Origins setup.

## What you get

- **Docker** (default tab): search, filter (all/running/stopped), sort, comfortable/compact
  density, per-row start/stop/restart, tap a row for a detail panel (start/stop/restart/pause/
  resume/update, image, ports, autostart), bulk **start all / stop all / update all pending**.
  The knob scrolls the list.
- **Overview**: CPU, RAM, array capacity, parity status, **UPS** (charge/load/runtime/nominal),
  and a **GPU** card (see limitations).
- **Storage**: per-disk capacity, temperature, SMART status, and parity-check controls.
- **VMs**: list + start/stop.
- **Alerts**: unread Unraid notifications.

Destructive actions (stop, restart, update, stop-all, VM stop, parity control) ask to confirm.

## Known limitations (Unraid API scope)

- **GPU stats and per-container CPU/memory are not in the Unraid GraphQL API.** They're supplied
  by the optional stats-api add-on above; without it, those show an honest "no data" state.
- **Container logs** aren't in the API at all — use "Open logs in web UI".
- **Compose-stack grouping** and **per-container "update available" badges** await a confirmed
  schema field; the update *actions* work regardless.

## Schema this app queries (verify on your server)

If a card shows no data, introspect these in **Settings → Management Access → API → GraphQL
Sandbox** and adjust `server.js` if a field name differs on your build:

- `dockerContainers { id names image state status autoStart ports }`
- `info { os { hostname uptime } versions { core { unraid } } }` · `metrics { cpu { percentTotal } memory { total used percentTotal } }`
- `array { state capacity { kilobytes { free used total } } disks { name temp status fsSize fsFree } parityCheckStatus { status progress running errors } }`
- `notifications { overview { unread { … } } list(filter:{type:UNREAD}) { … } }`
- `upsDevices { name model status battery { chargeLevel estimatedRuntime } power { loadPercentage nominalPower } }`
- `vms { domains { id name state } }`
- Mutations: `docker { start/stop/pause/unpause/updateContainer/updateAllContainers }`, `vm { start/stop }`, `parityCheck { start/pause/resume/cancel }`

Non-critical queries are isolated, so a mismatch degrades one card rather than blanking the panel;
the Docker list is fetched on its own and is the most resilient.
