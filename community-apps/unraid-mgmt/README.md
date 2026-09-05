# Unraid Manager

Monitor and manage several Unraid servers from the panel. **Docker-first** — built to stay
usable with 60+ containers — plus array/disks/parity, UPS, VMs, network, and notifications.

## Requirements

- **Unraid 7.2 or newer** on each server (the GraphQL API is built into the OS; no Connect
  plugin needed). Verified against 7.3.x.
- An **API key** per server (admin role, so start/stop/update works).

## Setup

1. On the Unraid server: **Settings → Management Access → API → API Keys → Create** with the
   **admin** role (CLI equivalent: `unraid-api apikey --create`).
2. In the panel, open this app's **App options** and fill in **Server 1**:
   - **URL** — the webGUI address, e.g. `http://192.168.1.25` (do **not** add `/graphql`).
   - **API key** — from step 1.
   - **name** — the label shown in the left rail.
3. Need more servers? Tick **"＋ Add a second server"** to reveal the next slot (up to four,
   each revealing the next).

Options:
- **Server N stats-api URL** — optional; enables GPU, per-container CPU/mem/VRAM, and readable
  container logs (see below).
- **Verify HTTPS certificate** — uncheck only if a URL is `https` with a self-signed cert.
- **Allow container controls** — off = read-only panel (no start/stop/update/array/VM actions;
  logs and monitoring still work).
- **Refresh interval** — 5 / 10 / 30 s.

The API key is stored encrypted at rest and used only server-side (never placed in a URL or sent
to the browser); all Unraid calls happen in the host, so there is no CORS/Extra-Origins setup.

## The stats-api add-on (GPU, per-container stats, logs)

The Unraid GraphQL API does **not** expose GPU stats, per-container CPU/memory, or container
logs. The tiny **stats-api** add-on ([github.com/TeeJS/stats](https://github.com/TeeJS/stats))
fills those gaps — it serves host GPU + per-container CPU/mem/VRAM as JSON, and per-container
logs as a page, on port 19998. Run it on the server and put its URL
(e.g. `http://192.168.1.25:19998`) in that server's **stats-api URL** option. Then you get:

- a live **GPU** card on Overview + a GPU chip up top,
- **CPU% · memory** on every Docker row and in the detail panel,
- readable, colored **container logs** in your browser (the ☰ button on each row).

Leave the option blank and those degrade to an honest "no data" state. The add-on is
unauthenticated — keep it LAN-only.

## What you get

- **Overview** (default tab): CPU, RAM, array capacity, and **network** throughput
  (inbound/outbound with utilization bars), plus a **GPU** card and a **UPS** card
  (charge / load / runtime / nominal).
- **Docker** — built for 60+ containers: search, filter (all / running / stopped / **updates**),
  sort, comfortable/compact density, aligned columns. Each row: state, CPU·mem, uptime, and
  buttons for start/stop/restart, **apply update** (amber ⬆ when one is pending), and **logs** (☰).
  Tap a row for a detail panel. Side rail: an updates count, **Check for updates**,
  **Update all pending**, Start all / Stop all, Open web UI. The knob scrolls the list.
- **Storage**: per-disk capacity, temperature, SMART status, and parity-check controls.
- **VMs**: list + start/stop.
- **Alerts**: unread Unraid notifications.

Destructive actions (stop, restart, update, stop-all, VM stop, parity control) ask to confirm.

## Notes / limitations

- **GPU, per-container CPU/memory, and logs** come from the stats-api add-on above; without it
  they show "no data" (and the logs button won't work).
- Container logs open in the **browser**, not on the panel (they'd be too small at arm's length).
  Unraid's own log view is an on-demand ttyd session that can't be deep-linked, which is why the
  add-on serves them instead.
- **Compose-stack grouping** isn't implemented yet.

## Schema this app queries (verify on your server)

If a card shows no data, introspect these in **Settings → Management Access → API → GraphQL
Sandbox** and adjust `server.js` if a field name differs on your build. Non-critical queries are
isolated, so a mismatch degrades one card rather than blanking the panel; the Docker list is
fetched on its own and is the most resilient.

- `docker { containers { id names image state status autoStart ports { ip privatePort publicPort } } }`
- `docker { containers { id isUpdateAvailable isRebuildReady } }` (update badges, isolated)
- `info { os { hostname uptime } versions { core { unraid } } }` · `metrics { cpu { percentTotal } memory { total used percentTotal } network { name rxSec txSec utilizationPercent } }`
- `array { state capacity { kilobytes { free used total } } disks { name temp status fsSize fsFree } parityCheckStatus { status progress running errors } }`
- `notifications { overview { unread { total } } list(filter:{type:UNREAD}) { … } }`
- `upsDevices { name model status battery { chargeLevel estimatedRuntime } power { loadPercentage nominalPower } }`
- `vms { domains { id name state } }`
- Mutations: `docker { start / stop / pause / unpause / updateContainer / updateAllContainers / refreshDockerDigests }`, `vm { start / stop }`, `parityCheck { start / pause / resume / cancel }`
