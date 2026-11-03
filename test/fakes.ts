import type { Logger, PluginStorage, ServiceContext, StoredRow, TableSchema, TableStorage } from '@zflow/sdk';
import { ZDevicesService, type CentralEvent, type CentralHandle } from '../src/service.ts';
import {
  deviceId,
  type Device,
  type DeviceInput,
  type DeviceReport,
  type IotService,
  type MqttEvent,
  type MqttService,
} from '../src/zflow-plugins.ts';

function memoryTables(): TableStorage {
  const tables = new Map<string, { schema: TableSchema; rows: StoredRow[] }>();
  let nextId = 1;
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
      return {
        insert: (row, at = Date.now()) => void table.rows.push({ ...row, id: nextId++, at }),
        put(row, at = Date.now()) {
          const key = Object.fromEntries((table.schema.key ?? []).map((column) => [column, row[column]]));
          table.rows = table.rows.filter((existing) => !matches(existing, key));
          table.rows.push({ ...row, id: nextId++, at });
        },
        rows: (query = {}) => {
          const rows = table.rows.filter((row) => matches(row, query.where));
          return query.limit === undefined ? rows : rows.slice(0, query.limit);
        },
        delete(filter) {
          const before = table.rows.length;
          table.rows = table.rows.filter((row) => !matches(row, filter.where));
          return before - table.rows.length;
        },
        aggregate: () => null,
        series: () => [],
        deleteBefore(at) {
          const before = table.rows.length;
          table.rows = table.rows.filter((row) => row.at >= at);
          return before - table.rows.length;
        },
      };
    },
  };
}

export function memoryStorage(): PluginStorage {
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

/** Keeps project devices in the iot plugin's tables, as the real registry does, so the plugin's listing reads them. */
export class FakeIot implements IotService {
  private readonly storage: PluginStorage;
  constructor(storage: PluginStorage) {
    this.storage = storage;
  }
  start() {}
  stop() {}
  registerProvider() {
    return () => {};
  }
  devices(projectId?: string, filter: { provider?: string } = {}): Device[] {
    if (!projectId || !this.storage.project(projectId).tables().includes('devices')) return [];
    return this.table(projectId)
      .rows({ where: { ...(filter.provider && { provider: filter.provider }) } })
      .map((row) => ({ ...(row as unknown as Device), id: deviceId(row.provider as string, row.externalId as string), projectId }));
  }
  device(projectId: string, externalId: string): Device | undefined {
    return this.devices(projectId).find((device) => device.externalId === externalId);
  }
  upsert(provider: string, input: DeviceInput, projectId?: string): Device {
    const existing = this.device(projectId!, input.externalId);
    const device = { state: {}, online: null, addedAt: 1, ...existing, ...input, provider, name: existing?.name ?? input.name };
    return this.save(projectId!, device as Device);
  }
  report(provider: string, externalId: string, report: DeviceReport, projectId?: string): Device | undefined {
    const existing = this.device(projectId!, externalId);
    if (!existing) return undefined;
    return this.save(projectId!, {
      ...existing,
      state: { ...existing.state, ...report.state },
      ...(report.online !== undefined && { online: report.online }),
      ...(report.state && { lastSeen: report.at }),
    });
  }
  rename(id: string, name: string, projectId?: string): Device {
    return this.save(projectId!, { ...this.devices(projectId).find((candidate) => candidate.id === id)!, name });
  }
  remove(provider: string, externalId: string, projectId?: string) {
    this.table(projectId!).delete({ where: { provider, externalId } });
  }
  private save(projectId: string, device: Device): Device {
    const row: Record<string, unknown> = { ...device };
    delete row.id;
    delete row.projectId;
    this.table(projectId).put(row);
    return { ...device, id: deviceId(device.provider, device.externalId), projectId };
  }
  private table(projectId: string) {
    return this.storage.project(projectId).table('devices', { columns: {}, key: ['provider', 'externalId'] });
  }
}

export class FakeMqtt implements MqttService {
  readonly published: { connection: string; topic: string; payload: unknown; retain?: boolean }[] = [];
  private readonly listeners = new Map<string, Set<(event: MqttEvent) => void>>();
  start() {}
  stop() {}
  subscribe(connectionId: string, listener: (event: MqttEvent) => void) {
    const set = this.listeners.get(connectionId) ?? new Set();
    set.add(listener);
    this.listeners.set(connectionId, set);
    return () => set.delete(listener);
  }
  async publish(connection: string, message: { topic: string; payload: unknown; retain?: boolean }) {
    this.published.push({ connection, ...message });
  }
  deliver(connectionId: string, topic: string, payload: unknown, clientId: string | null = 'central-1') {
    const event: MqttEvent = { event: 'message', connectionId, clientId, topic, payload, qos: 0, retain: false };
    for (const listener of this.listeners.get(connectionId) ?? []) listener(event);
  }
  disconnect(connectionId: string, clientId: string) {
    for (const listener of this.listeners.get(connectionId) ?? []) {
      listener({ event: 'disconnected', connectionId, clientId });
    }
  }
  listening(connectionId: string) {
    return this.listeners.get(connectionId)?.size ?? 0;
  }
  lastOn(topic: string) {
    return this.published.filter((message) => message.topic === topic).at(-1);
  }
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function setup(settings: unknown = { connections: [{ connection: 'broker' }], historyDays: 365 }) {
  const storage = memoryStorage();
  const iot = new FakeIot(storage.of('iot'));
  const mqtt = new FakeMqtt();
  const ctx: ServiceContext = {
    pluginId: 'zdevices',
    settings,
    logger: silent,
    storage,
    dataDir: '/tmp',
    service: <T,>(id: string) => (id === 'iot' ? iot : mqtt) as T,
  };
  const service = new ZDevicesService(ctx);
  service.start();
  return { storage, iot, mqtt, service };
}

export function recorder(): CentralHandle & { events: CentralEvent[] } {
  const events: CentralEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
}
