import type { PluginStorage, StoredRow, TableSchema, TableStorage } from '@zflow/sdk';
import { PROVIDER, type PropertyKind } from './catalogue.ts';
import { deviceId, IOT, type Device } from './zflow-plugins.ts';

// The paired centrals; the ones only heard live in the service's memory.
const CENTRALS_SCHEMA: TableSchema = { columns: { central: 'text' }, key: ['central'] };

// The Z details next to each paired device's iot entry.
const DETAILS_SCHEMA: TableSchema = {
  columns: {
    externalId: 'text',
    model: 'number',
    firmware: 'text',
    reportInterval: 'number',
    batteryPowered: 'json',
    properties: 'json',
    lastSeq: 'number',
    lastCentral: 'text',
    lastReport: 'number',
  },
  key: ['externalId'],
};

// How each central hears each device, from its seen lists and the reports it relays.
const LINKS_SCHEMA: TableSchema = {
  columns: { central: 'text', externalId: 'text', linkquality: 'number', lastSeen: 'number' },
  indexes: ['externalId'],
  key: ['central', 'externalId'],
};

export const centralsOf = (storage: TableStorage) => storage.table('centrals', CENTRALS_SCHEMA);
export const detailsOf = (storage: TableStorage) => storage.table('devices', DETAILS_SCHEMA);
export const linksOf = (storage: TableStorage) => storage.table('links', LINKS_SCHEMA);

export interface Details {
  externalId: string;
  model?: number;
  firmware?: string;
  reportInterval?: number;
  batteryPowered?: boolean;
  properties: Record<string, PropertyKind>;
  lastSeq?: number;
  lastCentral?: string;
  lastReport?: number;
}

export interface Link {
  central: string;
  externalId: string;
  linkquality?: number;
  lastSeen?: number;
}

export const toDetails = (row: StoredRow): Details => ({
  ...(withoutNulls(row) as unknown as Details),
  properties: (row.properties as Record<string, PropertyKind> | null) ?? {},
});

export const toLink = (row: StoredRow): Link => withoutNulls(row) as unknown as Link;

/** Z Devices as the iot registry keeps them, from iot's tables. */
export function registryDevices(iot: TableStorage): Device[] {
  if (!iot.tables().includes('devices')) return [];
  return iot
    .table('devices')
    .rows({ where: { provider: PROVIDER } })
    .map((row) => ({
      ...(withoutNulls(row) as unknown as Device),
      id: deviceId(PROVIDER, row.externalId as string),
      online: (row.online as boolean | null) ?? null,
      state: (row.state as Record<string, unknown> | null) ?? {},
      capabilities: (row.capabilities as Device['capabilities'] | null) ?? [],
    }));
}

/** A paired device as the Studio shows it: the registry's device with its Z details and how each central hears it. */
export interface ZDevice extends Device {
  details?: Details;
  links: Link[];
}

export function listZDevices(storage: PluginStorage): ZDevice[] {
  const tables = storage.tables();
  const details = new Map(
    tables.includes('devices') ? detailsOf(storage).rows().map((row) => [row.externalId as string, toDetails(row)]) : [],
  );
  const links = tables.includes('links') ? linksOf(storage).rows().map(toLink) : [];
  return registryDevices(storage.of(IOT))
    .map((device) => {
      const detail = details.get(device.externalId);
      return {
        ...device,
        ...(detail && { details: detail }),
        links: links.filter((link) => link.externalId === device.externalId),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function withoutNulls(row: StoredRow): Record<string, unknown> {
  const fields = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
  delete fields.id;
  delete fields.at;
  return fields;
}
