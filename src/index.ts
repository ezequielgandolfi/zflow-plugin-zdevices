import { definePlugin, type PluginActionContext } from '@zflow/sdk';
import packageJson from '../package.json' with { type: 'json' };
import { blueprintOptions, blueprints } from './blueprints.ts';
import { PROVIDER } from './catalogue.ts';
import { normalizeDeviceId } from './protocol.ts';
import { zDevicesService } from './service.ts';
import { DEFAULT_SETTINGS, validateSettings } from './settings.ts';
import { listZDevices } from './store.ts';
import { deviceId, IOT } from './zflow-plugins.ts';

const forward = (command: string) => (ctx: PluginActionContext) => ctx.command(command, ctx.input);

const idOf = (input: unknown) => normalizeDeviceId((input as { id?: unknown } | null)?.id);

export default definePlugin({
  id: PROVIDER,
  name: 'Z Devices',
  description: 'Pairs Z Centrals and the Z Devices they relay over MQTT, keeping their history',
  version: packageJson.version,
  dependencies: {
    iot: '0.1.0',
    mqtt: '0.1.0',
    dashboards: { version: '0.1.0', optional: true },
    notify: { version: '0.1.0', optional: true },
  },
  service: zDevicesService,
  projects: { blueprints },
  settings: { defaults: DEFAULT_SETTINGS, validate: validateSettings, options: blueprintOptions },
  actions: {
    devices: ({ storage }) => listZDevices(storage),
    permitJoin: forward('permitJoin'),
    stopJoin: forward('stopJoin'),
    pair: forward('pair'),
    pairCentral: forward('pairCentral'),
    unpairCentral: forward('unpairCentral'),
    remove: forward('remove'),
    rename: (ctx) => {
      const { name } = (ctx.input ?? {}) as { name?: unknown };
      return ctx.command('rename', { device: deviceId(PROVIDER, idOf(ctx.input)), name }, IOT);
    },
  },
  studio: './studio.tsx',
});
