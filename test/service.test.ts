import type { Logger, PluginStorage, ServiceContext, StoredRow, TableSchema, TableStorage } from '@zflow/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER } from '../src/device-types.ts';
import { deviceId, type Device, type DeviceInput, type DeviceProvider, type IotService } from '../src/iot.ts';
import { ZDevicesService } from '../src/service.ts';
import { listZDevices } from '../src/store.ts';

function memoryTables(): TableStorage {
  const tables = new Map<string, { schema: TableSchema; rows: StoredRow[] }>();
  const matches = (row: StoredRow, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([column, value]) => row[column] === value);
  return {
    tables: () => [...tables.keys()],
    drop: (name) => void tables.delete(name),
    table(name, schema) {
      if (!tables.has(name)) {
        if (!schema) throw new Error(`No table ${name}`);
        tables.set(name, { schema, rows: [] });
      }
      const table = tables.get(name)!;
      let nextId = 1;
      return {
        insert: (row, at = Date.now()) => void table.rows.push({ ...row, id: nextId++, at }),
        put(row, at = Date.now()) {
          const key = Object.fromEntries((table.schema.key ?? []).map((column) => [column, row[column]]));
          table.rows = table.rows.filter((existing) => !matches(existing, key));
          table.rows.push({ ...row, id: nextId++, at });
        },
        rows: (query = {}) => table.rows.filter((row) => matches(row, query.where)),
        delete(filter) {
          const before = table.rows.length;
          table.rows = table.rows.filter((row) => !matches(row, filter.where));
          return before - table.rows.length;
        },
        aggregate: () => null,
        series: () => [],
        deleteBefore: () => 0,
      };
    },
  };
}

function memoryStorage(): PluginStorage {
  const projects = new Map<string, TableStorage>();
  const plugins = new Map<string, PluginStorage>();
  return {
    ...memoryTables(),
    project(projectId) {
      if (!projects.has(projectId)) projects.set(projectId, memoryTables());
      return projects.get(projectId)!;
    },
    of(pluginId) {
      if (!plugins.has(pluginId)) plugins.set(pluginId, memoryStorage());
      return plugins.get(pluginId)!;
    },
  };
}

// Writes its project devices into the iot plugin's tables, as the real registry does, so listing reads them back.
class FakeIot implements IotService {
  providers = new Map<string, DeviceProvider>();
  private readonly storage: PluginStorage;
  constructor(storage: PluginStorage) {
    this.storage = storage;
  }
  start() {}
  stop() {}
  registerProvider(pluginId: string, provider: DeviceProvider) {
    this.providers.set(pluginId, provider);
    return () => this.providers.delete(pluginId);
  }
  devices(projectId?: string, filter: { provider?: string } = {}): Device[] {
    if (!projectId || !this.storage.project(projectId).tables().includes('devices')) return [];
    return this.table(projectId)
      .rows({ where: { ...(filter.provider && { provider: filter.provider }) } })
      .map((row) => ({ ...(row as unknown as Device), id: deviceId(row.provider as string, row.externalId as string), projectId }));
  }
  upsert(provider: string, input: DeviceInput, projectId?: string): Device {
    const existing = this.devices(projectId, { provider }).find((device) => device.externalId === input.externalId);
    const device = { state: {}, online: null, addedAt: 1, ...existing, ...input, provider, name: existing?.name ?? input.name };
    this.table(projectId!).put(device);
    return { ...device, id: deviceId(provider, input.externalId), projectId };
  }
  rename(id: string, name: string, projectId?: string): Device {
    const device = { ...this.devices(projectId).find((candidate) => candidate.id === id)!, name };
    this.table(projectId!).put(device);
    return device;
  }
  remove(provider: string, externalId: string, projectId?: string) {
    this.table(projectId!).delete({ where: { provider, externalId } });
  }
  private table(projectId: string) {
    return this.storage
      .project(projectId)
      .table('devices', { columns: {}, key: ['provider', 'externalId'] });
  }
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('ZDevicesService', () => {
  let storage: PluginStorage;
  let iot: FakeIot;
  let service: ZDevicesService;

  beforeEach(() => {
    storage = memoryStorage();
    iot = new FakeIot(storage.of('iot'));
    const ctx: ServiceContext = {
      pluginId: PROVIDER,
      settings: {},
      logger: silent,
      storage,
      dataDir: '',
      service: <T,>() => iot as unknown as T,
    };
    service = new ZDevicesService(ctx);
    service.start();
  });

  const list = () => listZDevices(storage, 'p1');

  it('registers as a provider that refuses writes', () => {
    const device = { name: 'Garden' } as Device;
    expect(() => iot.providers.get(PROVIDER)!.write(device, {})).toThrow(/can't be controlled/);
    service.stop();
    expect(iot.providers.has(PROVIDER)).toBe(false);
  });

  it('creates a device in the project and lists it with its type', () => {
    service.commands.create({ projectId: 'p1', id: 'A0:B7:65:12:34:56', name: ' Garden ', typeId: 1002 });
    expect(list()).toEqual([
      {
        id: 'a0b765123456',
        name: 'Garden',
        typeId: 1002,
        typeName: 'Weather station',
        sensors: ['Temperature', 'Humidity', 'Pressure'],
        online: null,
      },
    ]);
    expect(listZDevices(storage, 'p2')).toEqual([]);
  });

  it('refuses a second device with the same id', () => {
    service.commands.create({ projectId: 'p1', id: 'a1', name: 'One', typeId: 1001 });
    expect(() => service.commands.create({ projectId: 'p1', id: 'A1', name: 'Two', typeId: 1001 })).toThrow(
      /already a device/,
    );
  });

  it('updates the name and type', () => {
    service.commands.create({ projectId: 'p1', id: 'a1', name: 'Tank', typeId: 1001 });
    service.commands.update({ projectId: 'p1', id: 'a1', name: 'Water tank', typeId: 1004 });
    expect(list()).toMatchObject([{ id: 'a1', name: 'Water tank', typeId: 1004, sensors: ['Distance'] }]);
  });

  it('refuses to update a device that is gone', () => {
    expect(() => service.commands.update({ projectId: 'p1', id: 'a1', name: 'Tank', typeId: 1001 })).toThrow(
      /doesn't exist/,
    );
  });

  it('removes a device', () => {
    service.commands.create({ projectId: 'p1', id: 'a1', name: 'Tank', typeId: 1001 });
    service.commands.remove({ projectId: 'p1', id: 'a1' });
    expect(list()).toEqual([]);
    expect(storage.project('p1').table('devices').rows()).toEqual([]);
  });

  it('needs a project', () => {
    expect(() => service.commands.create({ id: 'a1', name: 'Tank', typeId: 1001 })).toThrow(/project/);
  });
});
