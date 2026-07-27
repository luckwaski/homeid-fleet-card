# HomeID Fleet Card

A Home Assistant Lovelace card for managing a **fleet of HomeID ESP8266 devices**:
lists every device with its **firmware version** and online state, and lets you run
**OTA updates straight from the list** — a single device, or many selected at once,
executed **strictly one after another** (never in parallel).

Works with any device running the HomeID firmware core (relay, heater, dry-contact
relay, LED dimmer, 230 V dimmer, …) — everything the firmware announces through MQTT
discovery is picked up automatically. No custom component and no firmware changes
required; the card is pure frontend.

## Features

- **Fleet list** built from the HA device registry (filtered by manufacturer
  `HomeID`): name, model, chip ID, IP, RSSI, online/offline dot and firmware version.
- **Stale-version highlight** — devices running an older firmware than the newest
  one seen in the fleet (compared per model) are marked orange, with a fleet-wide
  counter in the summary line.
- **Sequential batch updates** — tick the devices (or "select online"), press
  *Aktualizuj zaznaczone*, and the card updates them one by one: it presses the
  device's update button, watches the OTA status sensor
  (`downloading` → device reboots → back online) and only then moves to the next
  one, with a configurable pause in between. Clicking a row's update button during
  a running batch appends that device to the same queue.
- **Per-device result** — `old version → new version`, *up to date*, the firmware's
  failure reason (`failed (n)` / `no wifi`), or timeout. Offline devices are skipped.
- **Cancel remaining** queue mid-batch (the update already running on a device
  finishes on its own), optional stop-on-error, per-device restart button
  (with confirmation), and a UI config editor.

## Requirements

HomeID firmware with MQTT + Home Assistant discovery, i.e. devices that expose:

- the *Zainstaluj aktualizacje* `button` entity (`device_class: update`,
  publishes to `homeid/<id>/update/set`),
- the *Status aktualizacji* diagnostic sensor (`homeid/<id>/ota/state`),
- availability via LWT (`homeid/<id>/status`),
- `manufacturer: HomeID` and `sw_version` in the discovery device info.

## Installation

### HACS (custom repository)

1. HACS → three-dot menu → **Custom repositories**.
2. Repository: `https://github.com/luckwaski/homeid-fleet-card`, category
   **Lovelace/Dashboard**.
3. Install **HomeID Fleet Card**, then reload resources / hard-refresh (Ctrl-F5).

### Manual

1. Copy `dist/homeid-fleet-card.js` to your HA `config/www/`.
2. Settings → Dashboards → **Resources** → Add: URL `/local/homeid-fleet-card.js`,
   type **Module**.
3. Hard-refresh the browser.

## Usage

Minimal — one line on any dashboard:

```yaml
type: custom:homeid-fleet-card
```

All options (defaults shown):

```yaml
type: custom:homeid-fleet-card
title: HomeID — flota
manufacturer: HomeID     # device-registry manufacturer filter
timeout: 300             # seconds allowed per device (download + reboot + reconnect)
settle: 5                # pause between devices in a batch, seconds
stop_on_error: false     # true = abort the remaining queue after a failure/timeout
show_diagnostics: true   # show IP + RSSI under the device name
```

## How it works

The card talks only to standard Home Assistant APIs:

- fleet list: `config/device_registry/list` filtered by manufacturer; the firmware
  version is the `sw` field the device publishes in MQTT discovery,
- update: `button.press` on the device's update button entity,
- progress: the OTA status sensor plus entity availability; a device that comes
  back online after the `downloading` phase re-publishes discovery with its new
  version, which refreshes the version column automatically.

> **Note:** the update queue runs in the browser tab. Keep the dashboard open until
> the batch finishes — closing the tab cancels the devices still waiting in the
> queue (an update already running on a device completes regardless).

## License

MIT — see [LICENSE](LICENSE).
