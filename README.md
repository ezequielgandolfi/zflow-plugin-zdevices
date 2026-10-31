# zflow-plugin-zdevices

A zflow plugin (built with the [zflow plugin kit](https://github.com/ezequielgandolfi/zflow-types)) that brings Z Devices into zflow's built-in device
registry (the `iot` plugin). It adds a **Z Devices** section to each project's page to add, edit and remove the
project's devices:

| Type id | Type            | Properties                          |
| ------- | --------------- | ----------------------------------- |
| 1001    | Water detector  | Status (on/off)                     |
| 1002    | Weather station | Temperature, humidity, pressure     |
| 1003    | Power meter     | Power, voltage, current, energy     |
| 1004    | Water level     | Distance                            |

Devices are kept per project, with the board's MAC address (lowercase, no colons) as their id. They show up in the
registry as `zdevices:<id>`, so the Devices steps and widgets can pick them. They don't report readings yet.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run package   # builds dist/zflow-plugin.tgz
```

To try it in zflow without releasing, pack it and start zflow with `PLUGINS_DIR` set to a folder holding
`dist/zflow-plugin`.

## Release

Run the **Release** workflow from the Actions tab on the default branch and pick `patch`, `minor` or `major`. It bumps
`package.json`, checks and packs the plugin, commits and tags `v<version>`, then creates the GitHub release with
`zflow-plugin.tgz`, which the Studio's Plugins page installs from. The workflow pushes to the default branch, so it
needs to be allowed to (no branch protection, or a bypass for GitHub Actions).
