# zflow-plugin-zdevices

A zflow plugin (built with the [zflow plugin kit](https://github.com/ezequielgandolfi/zflow-types)) for the Z Devices
ecosystem: battery sensors that talk ESP-NOW to **Z Centrals**, which relay them to an MQTT broker. The plugin speaks
[Z Devices protocol v2](docs/z-protocol-v2.md) and builds on zflow's built-in `iot`, `mqtt` and `templates` plugins.

- **Central discovery:** on the Admin page's **Z Devices** card, pick the MQTT connections centrals publish to. Every
  central that pings one of them (`zdevices/<central>/bridge/info`, every 60 s) is listed there. The list lives in
  memory and fills again after a restart from the pings.
- **Z Central integration:** add one to a project per central and pick a discovered central. A central can be in one
  project at a time. Its bindings start automations when the central goes online or offline, or hears a device that
  isn't in the project (the **Z Central event** start step).
- **Z Devices section** on the project page: one card per central, with **Find devices** (what the central heard in
  the last hour) to add devices, plus rename and remove. A device is unique in the project, but several centrals can
  relay it, for range. The plugin sends each central its relay list, and centrals only answer the handshakes of
  devices on it.
- **Device registry:** devices show up in `iot` as `zdevices:<mac>`, with Zigbee-style properties (`temperature`,
  `humidity`, `pressure`, `power`, `voltage`, `current`, `energy`, `ac_frequency`, `power_factor`, `water_leak`,
  `distance`, `battery`, `linkquality`). So the Devices steps and widgets can read them. A device goes offline when no
  report arrives for `2 × report_interval + 60 s`.
- **Readings** are kept per project, for the **Z Device history** (chart) and **Z Device activity** (timeline) widgets.
  They're deleted after the number of days set on the Admin page (365 by default).

| Model    | Device          | Properties                                                     |
| -------- | --------------- | -------------------------------------------------------------- |
| `0x0101` | Water detector  | water_leak, battery                                            |
| `0x0102` | Weather station | temperature, humidity, pressure, battery                       |
| `0x0103` | Power meter     | power, voltage, current, energy, ac_frequency, power_factor    |
| `0x0104` | Water level     | distance, battery                                              |

Devices only send readings for now; writes to them are refused. Security options for later are in
[docs/z-security-options.md](docs/z-security-options.md).

## Develop

```bash
npm install
npm run typecheck
npm test
npm run package   # builds dist/zflow-plugin.tgz
```

To try it in zflow without releasing, pack it and start zflow with `PLUGINS_DIR` set to a folder holding
`dist/zflow-plugin`.

### Simulated central

`scripts/simulate-central.ts` acts as a central with one device of each model, so you can test without firmware.
Point it at a broker from zflow's MQTT page and pick that broker on the Z Devices admin card:

```bash
npm run simulate -- mqtt://localhost:1883 central-sim [username] [password]
```

It pings, answers **Find devices**, and reports only the devices on the relay list zflow sends it. Stop it with Ctrl+C
to see the central go offline.

## Release

Run the **Release** workflow from the Actions tab on the default branch and pick `patch`, `minor` or `major`. It bumps
`package.json`, checks and packs the plugin, commits and tags `v<version>`, then creates the GitHub release with
`zflow-plugin.tgz`, which the Studio's Plugins page installs from. The workflow pushes to the default branch, so it
needs to be allowed to (no branch protection, or a bypass for GitHub Actions).
