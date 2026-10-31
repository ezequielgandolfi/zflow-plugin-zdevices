import { defineService, type ServiceContext, type ServiceInstance } from '@zflow/sdk';
import { deviceTypeOf, normalizeId, normalizeName, PROVIDER, toDeviceInput } from './device-types.ts';
import { deviceId, IOT_PLUGIN, type Device, type IotService } from './iot.ts';
import { detailsOf } from './store.ts';

interface DeviceCommandInput {
  projectId: string;
  id: string;
}

function parseTarget(input: unknown): DeviceCommandInput & Record<string, unknown> {
  const fields = (input ?? {}) as Record<string, unknown>;
  if (typeof fields.projectId !== 'string' || fields.projectId === '') throw new Error('Say which project');
  return { ...fields, projectId: fields.projectId, id: normalizeId(fields.id) };
}

/** Keeps the Z Devices of each project in the iot registry. */
export class ZDevicesService implements ServiceInstance {
  private readonly ctx: ServiceContext;
  private unregister: (() => void) | undefined;

  readonly commands = {
    create: (input: unknown) => {
      const { projectId, id, name, typeId } = parseTarget(input);
      if (this.find(projectId, id)) throw new Error(`There's already a device with the id "${id}"`);
      return this.save(projectId, id, normalizeName(name), typeId);
    },
    update: (input: unknown) => {
      const { projectId, id, name, typeId } = parseTarget(input);
      if (!this.find(projectId, id)) throw new Error(`The device "${id}" doesn't exist anymore`);
      return this.save(projectId, id, normalizeName(name), typeId);
    },
    remove: (input: unknown) => {
      const { projectId, id } = parseTarget(input);
      this.iot().remove(PROVIDER, id, projectId);
      detailsOf(this.ctx.storage.project(projectId)).delete({ where: { externalId: id } });
      return null;
    },
  };

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  start(): void {
    this.unregister = this.iot().registerProvider(PROVIDER, {
      write: (device) => {
        throw new Error(`"${device.name}" can't be controlled from zflow yet`);
      },
    });
  }

  stop(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  private save(projectId: string, id: string, name: string, typeId: unknown): Device {
    const type = deviceTypeOf(typeId);
    const iot = this.iot();
    // upsert keeps the name a device already has, so renames go through the registry's own rename.
    let device = iot.upsert(PROVIDER, toDeviceInput(id, name, type), projectId);
    if (device.name !== name) device = iot.rename(deviceId(PROVIDER, id), name, projectId);
    detailsOf(this.ctx.storage.project(projectId)).put({ externalId: id, typeId: type.id });
    return device;
  }

  private find(projectId: string, id: string): Device | undefined {
    return this.iot()
      .devices(projectId, { provider: PROVIDER })
      .find((device) => device.projectId === projectId && device.externalId === id);
  }

  private iot() {
    return this.ctx.service<IotService>(IOT_PLUGIN);
  }
}

export const zDevicesService = defineService({ create: (ctx) => new ZDevicesService(ctx) });
