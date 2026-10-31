import type { PluginStorage, TableSchema, TableStorage } from '@zflow/sdk';
import { PROVIDER, Z_DEVICE_TYPES } from './device-types.ts';
import { IOT_PLUGIN, type Device } from './iot.ts';

/** A Z Device as the Studio shows it: the iot registry's device joined with what only Z Devices keep. */
export interface ZDevice {
  id: string;
  name: string;
  typeId: number | null;
  typeName: string;
  sensors: string[];
  online: boolean | null;
  lastSeen?: number;
}

// The iot registry keeps the device in its standard format; this table keeps the Z Devices details next to it.
const DETAILS_TABLE = 'devices';
const DETAILS_SCHEMA: TableSchema = {
  columns: { externalId: 'text', typeId: 'number' },
  key: ['externalId'],
};

export const detailsOf = (storage: TableStorage) => storage.table(DETAILS_TABLE, DETAILS_SCHEMA);

export function listZDevices(storage: PluginStorage, projectId: string): ZDevice[] {
  const iot = storage.of(IOT_PLUGIN).project(projectId);
  if (!iot.tables().includes('devices')) return [];
  const typeIds = new Map(
    detailsOf(storage.project(projectId))
      .rows()
      .map((row) => [row.externalId as string, row.typeId as number]),
  );
  return iot
    .table('devices')
    .rows({ where: { provider: PROVIDER } })
    .map((row) => {
      const device = row as unknown as Device;
      const typeId = typeIds.get(device.externalId) ?? null;
      return {
        id: device.externalId,
        name: device.name,
        typeId,
        typeName: Z_DEVICE_TYPES.find((type) => type.id === typeId)?.name ?? device.model ?? 'Unknown',
        sensors: (device.capabilities ?? []).map((capability) => capability.label),
        online: device.online ?? null,
        ...(device.lastSeen != null && { lastSeen: device.lastSeen }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
