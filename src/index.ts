import { definePlugin, type PluginActionContext } from '@zflow/sdk';
import packageJson from '../package.json' with { type: 'json' };
import { PROVIDER } from './device-types.ts';
import { zDevicesService } from './service.ts';
import { listZDevices } from './store.ts';

const forward = (command: string) => (ctx: PluginActionContext) => ctx.command(command, ctx.input);

export default definePlugin({
  id: PROVIDER,
  name: 'Z Devices',
  description: 'Keeps the Z Devices of each project in the device registry',
  version: packageJson.version,
  dependencies: { iot: '0.1.0' },
  service: zDevicesService,
  actions: {
    list: ({ input, storage }) => {
      const { projectId } = (input ?? {}) as { projectId?: unknown };
      if (typeof projectId !== 'string' || projectId === '') throw new Error('Say which project to list devices for');
      return listZDevices(storage, projectId);
    },
    create: forward('create'),
    update: forward('update'),
    remove: forward('remove'),
  },
  studio: './studio.tsx',
});
