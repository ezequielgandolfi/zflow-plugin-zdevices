# Agent notes

A zflow plugin for Z Devices: a service that listens to Z Centrals over MQTT and keeps their devices in zflow's `iot`
registry, a Studio page, and blueprints. See [README.md](README.md) for what it does.

## The zflow SDK and how zflow works

Whenever you need the plugin contract or how zflow behaves (`definePlugin`, services, storage, events, widgets,
blueprints, optional dependencies, Studio parts, packaging), read the zflow-types repo, cloned at
`/Users/egandolfi/personal/projects/zflow-types/`. Don't rely on memory or on `node_modules` alone: it's what the
`@zflow/*` packages here are released from.

- `README.md`: where each part of the contract lives, and the packaging rules.
- `WRITING-PLUGINS.md`: steps, runners, services, widgets, blueprints and Studio pages.
- `BUILT-IN-PLUGINS.md`: what `iot`, `mqtt`, `dashboards`, `notify` and the other built-ins offer. Only the SDK is
  published, so the interfaces used here are copied into [src/zflow-plugins.ts](src/zflow-plugins.ts); keep them in
  step with it.
- `STUDIO-UI.md`: the Studio's parts and styles, for [src/studio.tsx](src/studio.tsx).
- `sdk/*.d.ts`, `studio-sdk/index.d.ts`: the type definitions, with their doc comments.
- `git log` there shows what changed in each SDK release.

When updating the SDK, bump the three `@zflow/*` release URLs and `zflow.sdk` in [package.json](package.json)
together, and note the new minimum under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md).

## Working here

- `npm run typecheck`, `npm test` and `npm run package` must pass; the release workflow runs them with `npm ci`.
- Add each change under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), at the behaviour level.
