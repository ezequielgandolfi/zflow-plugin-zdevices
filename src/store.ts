import type { PluginStorage, StoredRow, TableSchema, TableStorage } from '@zflow/sdk';
import { modelOf, PROVIDER, type PropertyKind } from './catalogue.ts';
import type { CentralInfo } from './protocol.ts';
import { deviceId, IOT, type Device } from './zflow-plugins.ts';

/** A central counts as reachable while its pings (every 60 s) keep arriving. */
export const DISCOVERY_WINDOW = 3 * 60_000;

// Global: the centrals heard lately, so studio-server (options, actions) sees what the engine discovered.
const CENTRALS_SCHEMA: TableSchema = {
  columns: { central: 'text', connection: 'text', online: 'json', info: 'json', projectId: 'text' },
  key: ['central'],
};

// Per project: the Z details next to the iot device. v0.2's `typeId` column is left unused.
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

const RELAYS_SCHEMA: TableSchema = {
  columns: { central: 'text', externalId: 'text', linkquality: 'number', lastSeen: 'number' },
  indexes: ['externalId'],
  key: ['central', 'externalId'],
};

const READINGS_SCHEMA: TableSchema = {
  columns: { externalId: 'text', central: 'text', values: 'json' },
  indexes: [['externalId', 'at']],
};

export const centralsOf = (storage: TableStorage) => storage.table('centrals', CENTRALS_SCHEMA);
export const detailsOf = (storage: TableStorage) => storage.table('devices', DETAILS_SCHEMA);
export const relaysOf = (storage: TableStorage) => storage.table('relays', RELAYS_SCHEMA);
export const readingsOf = (storage: TableStorage) => storage.table('readings', READINGS_SCHEMA);

export interface CentralRow {
  central: string;
  connection: string;
  online: boolean | null;
  info: CentralInfo;
  projectId?: string;
  /** The latest ping, in ms since epoch. */
  at: number;
}

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

export interface Relay {
  central: string;
  externalId: string;
  linkquality?: number;
  lastSeen?: number;
}

export const toCentral = (row: StoredRow): CentralRow => ({
  central: row.central as string,
  connection: row.connection as string,
  online: (row.online as boolean | null) ?? null,
  info: (row.info as CentralInfo | null) ?? {},
  ...(typeof row.projectId === 'string' && row.projectId !== '' && { projectId: row.projectId }),
  at: row.at,
});

export const toDetails = (row: StoredRow): Details => ({
  ...(withoutNulls(row) as unknown as Details),
  properties: (row.properties as Record<string, PropertyKind> | null) ?? {},
});

export const toRelay = (row: StoredRow): Relay => withoutNulls(row) as unknown as Relay;

/** The centrals whose ping arrived in the discovery window, plus any the project holds. */
export function discoveredCentrals(storage: PluginStorage, projectId?: string, now = Date.now()): CentralRow[] {
  if (!storage.tables().includes('centrals')) return [];
  return centralsOf(storage)
    .rows()
    .map(toCentral)
    .filter((central) => central.at >= now - DISCOVERY_WINDOW || (projectId && central.projectId === projectId))
    .sort((a, b) => a.central.localeCompare(b.central));
}

/** The project's Z Devices as the iot registry keeps them, from iot's tables of the project. */
export function registryDevices(iot: TableStorage, projectId: string): Device[] {
  if (!iot.tables().includes('devices')) return [];
  return iot
    .table('devices')
    .rows({ where: { provider: PROVIDER } })
    .map((row) => {
      const fields = withoutNulls(row);
      return {
        ...(fields as unknown as Device),
        id: deviceId(PROVIDER, row.externalId as string),
        projectId,
        online: (row.online as boolean | null) ?? null,
        state: (row.state as Record<string, unknown> | null) ?? {},
        capabilities: (row.capabilities as Device['capabilities'] | null) ?? [],
      };
    });
}

/** A Z Device as the Studio shows it: the registry's device with its Z details and the centrals relaying it. */
export interface ZDevice {
  id: string;
  name: string;
  model: string;
  firmware?: string;
  reportInterval?: number;
  properties: string[];
  online: boolean | null;
  lastSeen?: number;
  battery?: number;
  relays: Relay[];
}

export function listZDevices(storage: PluginStorage, projectId: string): ZDevice[] {
  const project = storage.project(projectId);
  const tables = project.tables();
  const details = new Map(
    tables.includes('devices') ? detailsOf(project).rows().map((row) => [row.externalId as string, toDetails(row)]) : [],
  );
  const relays = tables.includes('relays') ? relaysOf(project).rows().map(toRelay) : [];
  return registryDevices(storage.of(IOT).project(projectId), projectId)
    .map((device) => {
      const detail = details.get(device.externalId);
      return {
        id: device.externalId,
        name: device.name,
        model: detail?.model !== undefined ? modelOf(detail.model).name : (device.model ?? 'Z Device'),
        ...(detail?.firmware && { firmware: detail.firmware }),
        ...(detail?.reportInterval !== undefined && { reportInterval: detail.reportInterval }),
        properties: device.capabilities.map((capability) => capability.label),
        online: device.online,
        ...(device.lastSeen !== undefined && { lastSeen: device.lastSeen }),
        ...(device.battery !== undefined && { battery: device.battery }),
        relays: relays.filter((relay) => relay.externalId === device.externalId),
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
