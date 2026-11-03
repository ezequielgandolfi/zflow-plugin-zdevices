# Changelog

## 0.3.0

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
