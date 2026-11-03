\# Changelog

## Unreleased

## 0.3.3 (2026-11-03)

- Fix component styling

## 0.3.2 (2026-11-03)

- New **Z Devices** page in the main menu, like the Zigbee page: turn the service on or off, pick the one MQTT broker
  the centrals publish to, and set how long readings are kept (365 days by default, empty keeps them forever)
- Centrals and devices are global, so every project can use them; centrals are paired from the page, and every paired
  central relays every paired device
- **Add devices** opens pairing for a few minutes and lists what the centrals hear, to pair each one with a name
- Device pages are the Devices plugin's, with state, history and activity, plus the Z details and the link quality per
  central; rename, delete history or remove from there or from the device's row
- History is kept by the Devices plugin, so its **Device history** and **Device activity** widgets show Z Devices
- New overview card with the service state, centrals online and devices offline
- Removed: the Admin card, the **Z Central** integration and its start step, the project section, and the
  **Z Device history** and **Z Device activity** widgets. Reinstall to start clean
- Needs SDK 0.1.10

## 0.3.1 (2026-11-03)

- Speaks Z Devices protocol v2 over MQTT; needs zflow's `iot`, `mqtt` and `templates` plugins and SDK 0.1.7
- New Admin card: pick the brokers centrals publish to, and see the centrals discovered from their pings
- New **Z Central** integration: a project takes a discovered central, which can be in only one project at a time
- New **Z Central event** start step: runs automations when a central goes online or offline, or hears a device not
  in the project
- Project section rebuilt: one card per central, **Find devices** to add what it heard, rename and remove
- A device can be relayed by several centrals of the project, for range; it stays until no central relays it
- Device readings reach the device registry with Zigbee-style property names (temperature, humidity, power,
  water_leak, battery, linkquality…)
- Devices go offline when they miss their reports (`2 × report_interval + 60 s`)
- Readings are stored per project and kept for a configurable number of days (365 by default)
- New **Z Device history** (chart) and **Z Device activity** (timeline) widgets
- Removed: adding devices by hand. Devices added that way show as "Not relayed by any central" and can be removed
