# zflow-plugin-zdevices

A zflow plugin (built with the [zflow plugin kit](https://github.com/ezequielgandolfi/zflow-types)) for the Z Devices
ecosystem: battery sensors that talk ESP-NOW to **Z Centrals**, which relay them to an MQTT broker. The plugin speaks
[Z Devices protocol v2](docs/z-protocol-v2.md) and builds on zflow's built-in `iot` (Devices) and `mqtt` plugins.

Everything happens on the **Z Devices** page (main menu), much like the Zigbee page. Centrals and devices are global:
once paired, every project can use them.

- **Service:** turn Z Devices on, pick the MQTT broker (from zflow's MQTT page) the centrals publish to, and set how
  many days readings are kept (365 by default; empty keeps them forever). Turning it off stops listening, and devices
  keep their last state.
- **Centrals:** every central that pings the broker (`zdevices/<central>/bridge/info`, every 60 s) shows under
  "Found on the broker". Pair it to have it relay. Every paired central relays every paired device, so more centrals
  cover more range; the plugin sends each one the relay list, and centrals only answer the handshakes of devices on it.
- **Add devices:** opens pairing for a few minutes. Every 10 s the plugin asks the online paired centrals what they
  heard in the last hour and lists the new devices under "New devices"; each one is paired with a name.
- **Device page:** click a device for the Devices plugin's page (state, history and activity), with the Z details
  (firmware, report interval) and how each central hears it below. Rename it, delete its history or remove it from
  there or from its row.
- **Device registry:** devices show up in `iot` as `zdevices:<mac>`, with Zigbee-style properties (`temperature`,
  `humidity`, `pressure`, `power`, `voltage`, `current`, `energy`, `ac_frequency`, `power_factor`, `water_leak`,
  `distance`, `battery`, `linkquality`). So the Devices steps and widgets can read them. A device goes offline when no
  report arrives for `2 × report_interval + 60 s`.
- **History** is kept by the Devices plugin, so its **Device history** and **Device activity** widgets show Z Devices.
- **Overview card:** whether the service runs, how many centrals are online and devices offline.
- **Blueprints** ("Add from blueprint" on a project page), each offering only the Z Devices it fits:
  - **Water leak alert:** notifies when a water detector finds a leak.
  - **Low water alert:** notifies when a water level sensor measures the water further down than a limit.
  - **Power meter:** a dashboard group with a power gauge, the energy, voltage and current, and a power chart.

  The alerts add their notification to the project's Notifications integration, so they need zflow's `notify`
  plugin; the dashboard one needs `dashboards`. Both are optional dependencies: without them only those blueprints
  are disabled. The iot plugin's own blueprints (Device dashboard, Climate sensor, Mirror a device) work for Z Devices
  too.

| Model    | Device          | Properties                                                     |
| -------- | --------------- | -------------------------------------------------------------- |
| `0x0101` | Water detector  | water_leak, battery                                            |
| `0x0102` | Weather station | temperature, humidity, pressure, battery                       |
| `0x0103` | Power meter     | power, voltage, current, energy, ac_frequency, power_factor    |
| `0x0104` | Water level     | distance, battery                                              |
| `0x0105` | Switch          | state (on/off, writable), battery                              |

Writable properties (only a switch's `state` for now) can be set from the device page, the Set device step or widgets.
The command goes to the central that last relayed the device, which holds it until the device's next report (within
its report interval); that report shows the new state. Security options for later are in
[docs/z-security-options.md](docs/z-security-options.md).

Add each change under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md); the release turns it into the version's section.

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
Point it at a broker from zflow's MQTT page, pick that broker on the Z Devices page and pair the central:

```bash
npm run simulate -- mqtt://localhost:1883 central-sim [username] [password]
```

It pings, answers **Add devices**, and reports only the devices on the relay list zflow sends it. Stop it with Ctrl+C
to see the central go offline.

## Release

Run the **Release** workflow from the Actions tab on the default branch and pick `patch`, `minor` or `major`. It bumps
`package.json`, checks and packs the plugin, renames the changelog's Unreleased section to the version (it fails when
that section is empty), commits and tags `v<version>`, then creates the GitHub release with those notes and
`zflow-plugin.tgz`, which the Studio's Plugins page installs from. The workflow pushes to the default branch, so it
needs to be allowed to (no branch protection, or a bypass for GitHub Actions).
