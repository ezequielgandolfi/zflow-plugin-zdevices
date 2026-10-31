import type { Capability, DeviceInput } from './iot.ts';

export const PROVIDER = 'zdevices';
export const MANUFACTURER = 'Z Devices';

export interface ZSensor {
  type: string;
  label: string;
  scaleMin: number;
  scaleMax: number;
  decimals: number;
  description: string;
}

export interface ZDeviceType {
  id: number;
  name: string;
  /** Minutes without a report before the device counts as offline. */
  defaultMaxIdleTime: number;
  sensors: ZSensor[];
}

// The Z Devices hardware types, from z-smart-server's device-types.js (1001–1004).
export const Z_DEVICE_TYPES: ZDeviceType[] = [
  {
    id: 1001,
    name: 'Water detector',
    defaultMaxIdleTime: 30,
    sensors: [
      { type: 'status', label: 'Status', scaleMin: 0, scaleMax: 1, decimals: 0, description: 'Indicates if water is detected' },
    ],
  },
  {
    id: 1002,
    name: 'Weather station',
    defaultMaxIdleTime: 5,
    sensors: [
      { type: 'temperature', label: 'Temperature', scaleMin: -50, scaleMax: 100, decimals: 1, description: 'Temperature in Celsius' },
      { type: 'humidity', label: 'Humidity', scaleMin: 0, scaleMax: 100, decimals: 0, description: 'Relative humidity percentage' },
      { type: 'pressure', label: 'Pressure', scaleMin: 900, scaleMax: 1100, decimals: 0, description: 'Atmospheric pressure in hPa' },
    ],
  },
  {
    id: 1003,
    name: 'Power meter',
    defaultMaxIdleTime: 1,
    sensors: [
      { type: 'power', label: 'Power', scaleMin: 0, scaleMax: 5000, decimals: 1, description: 'Power consumption in Watts' },
      { type: 'voltage', label: 'Voltage', scaleMin: 0, scaleMax: 250, decimals: 0, description: 'Voltage in Volts' },
      { type: 'current', label: 'Current', scaleMin: 0, scaleMax: 20, decimals: 2, description: 'Current in Amperes' },
      { type: 'energy', label: 'Energy', scaleMin: 0, scaleMax: 1000, decimals: 3, description: 'Energy in kWh' },
    ],
  },
  {
    id: 1004,
    name: 'Water level',
    defaultMaxIdleTime: 1,
    sensors: [
      { type: 'distance', label: 'Distance', scaleMin: 0, scaleMax: 400, decimals: 1, description: 'Distance to water surface in cm' },
    ],
  },
];

const UNITS: Record<string, string> = {
  temperature: '°C',
  humidity: '%',
  pressure: 'hPa',
  power: 'W',
  voltage: 'V',
  current: 'A',
  energy: 'kWh',
  distance: 'cm',
};

export function deviceTypeOf(typeId: unknown): ZDeviceType {
  const type = Z_DEVICE_TYPES.find((candidate) => candidate.id === Number(typeId));
  if (!type) throw new Error(`Pick one of the device types: ${Z_DEVICE_TYPES.map((t) => t.name).join(', ')}`);
  return type;
}

/** Device ids are the hardware's MAC address, kept lowercase and without colons. */
export function normalizeId(id: unknown): string {
  const normalized = typeof id === 'string' ? id.trim().toLowerCase().replace(/:/g, '') : '';
  if (normalized === '') throw new Error('Give the device its id, the MAC address of the board');
  return normalized;
}

export function normalizeName(name: unknown): string {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (normalized === '') throw new Error('Give the device a name');
  return normalized;
}

export function capabilityOf(sensor: ZSensor): Capability {
  const base = { property: sensor.type, label: sensor.label, access: 'read' as const };
  if (sensor.type === 'status') return { ...base, kind: 'binary', on: 1, off: 0 };
  return {
    ...base,
    kind: 'numeric',
    min: sensor.scaleMin,
    max: sensor.scaleMax,
    step: 10 ** -sensor.decimals,
    ...(UNITS[sensor.type] && { unit: UNITS[sensor.type] }),
  };
}

export function toDeviceInput(externalId: string, name: string, type: ZDeviceType): DeviceInput {
  return {
    externalId,
    name,
    type: 'sensor',
    model: type.name,
    manufacturer: MANUFACTURER,
    capabilities: type.sensors.map(capabilityOf),
  };
}
