import { definePlugin, type OptionsContext, type PluginActionContext, type PropertyOption } from '@zflow/sdk';
import packageJson from '../package.json' with { type: 'json' };
import { PROVIDER } from './catalogue.ts';
import { centralEvent, centralRunner } from './central.ts';
import { zDevicesService } from './service.ts';
import { DEFAULT_SETTINGS, validateSettings } from './settings.ts';
import { discoveredCentrals, listZDevices, registryDevices } from './store.ts';
import { activityWidget, historyWidget } from './widgets.ts';
import { deviceId, IOT, type Capability } from './zflow-plugins.ts';

const forward = (command: string) => (ctx: PluginActionContext) => ctx.command(command, ctx.input);

function projectOf(input: unknown): string {
  const { projectId } = (input ?? {}) as { projectId?: unknown };
  if (typeof projectId !== 'string' || projectId === '') throw new Error('Say which project');
  return projectId;
}

const projectDevices = ({ storage, projectId }: OptionsContext) =>
  projectId ? registryDevices(storage.of(IOT).project(projectId), projectId) : [];

const propertiesOf =
  (fits: (capability: Capability) => boolean) =>
  (ctx: OptionsContext): PropertyOption[] =>
    (projectDevices(ctx).find((device) => device.id === ctx.values.device)?.capabilities ?? [])
      .filter(fits)
      .map((capability) => ({ value: capability.property, label: capability.label }));

export default definePlugin({
  id: PROVIDER,
  name: 'Z Devices',
  description: 'Discovers Z Centrals on MQTT and keeps the Z Devices they relay in each project',
  version: packageJson.version,
  dependencies: { iot: '0.1.0', mqtt: '0.1.0', templates: '0.1.0' },
  service: zDevicesService,
  automations: { runners: [centralRunner], components: [centralEvent] },
  dashboards: { widgets: [historyWidget, activityWidget] },
  settings: {
    defaults: DEFAULT_SETTINGS,
    validate: validateSettings,
    options: {
      centrals: ({ storage, projectId }) =>
        discoveredCentrals(storage, projectId)
          .filter((central) => !central.projectId || central.projectId === projectId)
          .map((central) => ({
            value: central.central,
            label: central.online === false ? `${central.central} (offline)` : central.central,
          })),
      devices: (ctx) => projectDevices(ctx).map((device) => ({ value: device.id, label: device.name })),
      properties: propertiesOf((capability) => capability.access !== 'write'),
      numeric: propertiesOf((capability) => capability.access !== 'write' && capability.kind === 'numeric'),
    },
  },
  actions: {
    centrals: ({ storage, input }) => {
      const { projectId } = (input ?? {}) as { projectId?: unknown };
      return discoveredCentrals(storage, typeof projectId === 'string' ? projectId : undefined);
    },
    devices: ({ input, storage }) => listZDevices(storage, projectOf(input)),
    seen: forward('seen'),
    add: forward('add'),
    remove: forward('remove'),
    rename: (ctx) => {
      const { id, name } = (ctx.input ?? {}) as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || id === '') throw new Error('Say which device to rename');
      return ctx.command('rename', { device: deviceId(PROVIDER, id), name, project: projectOf(ctx.input) }, IOT);
    },
  },
  studio: './studio.tsx',
});
