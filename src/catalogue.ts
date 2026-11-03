import type { Capability, DeviceType } from './zflow-plugins.ts';

export const PROVIDER = 'zdevices';
export const MANUFACTURER = 'Z Devices';

export type PropertyKind = 'numeric' | 'binary' | 'text';

type PropertySpec = Omit<Capability, 'property' | 'access'>;

// The attributes of shared/ZAttributes.h (protocol v2, section 2), by the property name the central publishes them as.
export const PROPERTIES: Record<string, PropertySpec> = {
  temperature: { label: 'Temperature', kind: 'numeric', unit: '°C', min: -50, max: 100, step: 0.1 },
  humidity: { label: 'Humidity', kind: 'numeric', unit: '%', min: 0, max: 100, step: 0.1 },
  pressure: { label: 'Pressure', kind: 'numeric', unit: 'hPa', min: 300, max: 1100, step: 0.1 },
  power: { label: 'Power', kind: 'numeric', unit: 'W', min: 0 },
  voltage: { label: 'Voltage', kind: 'numeric', unit: 'V', min: 0 },
  current: { label: 'Current', kind: 'numeric', unit: 'A', min: 0 },
  energy: { label: 'Energy', kind: 'numeric', unit: 'kWh', min: 0 },
  ac_frequency: { label: 'AC frequency', kind: 'numeric', unit: 'Hz', min: 0 },
  power_factor: { label: 'Power factor', kind: 'numeric', min: 0, max: 1, step: 0.01 },
  water_leak: { label: 'Water leak', kind: 'binary', on: true, off: false },
  distance: { label: 'Distance', kind: 'numeric', unit: 'cm', min: 0, step: 0.1 },
  battery: { label: 'Battery', kind: 'numeric', unit: '%', min: 0, max: 100, health: 'battery' },
  linkquality: { label: 'Link quality', kind: 'numeric', unit: 'lqi', min: 0, max: 255, health: 'signal' },
};

const ORDER = Object.keys(PROPERTIES);

export interface ModelSpec {
  name: string;
  type: DeviceType;
}

export const MODELS: Record<number, ModelSpec> = {
  0x0101: { name: 'Water detector', type: 'sensor' },
  0x0102: { name: 'Weather station', type: 'sensor' },
  0x0103: { name: 'Power meter', type: 'sensor' },
  0x0104: { name: 'Water level', type: 'sensor' },
};

export const modelOf = (model: number | undefined): ModelSpec =>
  (model !== undefined && MODELS[model]) || {
    name: model === undefined ? 'Z Device' : `Z Device 0x${model.toString(16).padStart(4, '0')}`,
    type: 'other',
  };

export const kindOf = (value: unknown): PropertyKind =>
  PROPERTIES[value as string]?.kind === 'binary' || typeof value === 'boolean'
    ? 'binary'
    : typeof value === 'number'
      ? 'numeric'
      : 'text';

/** Each property's kind: the catalogue's, or guessed from the value for attributes zflow doesn't know yet. */
export function propertyKinds(values: Record<string, unknown>): Record<string, PropertyKind> {
  return Object.fromEntries(
    Object.entries(values).map(([property, value]) => [
      property,
      (PROPERTIES[property]?.kind as PropertyKind | undefined) ?? kindOf(value),
    ]),
  );
}

function capabilityOf(property: string, kind: PropertyKind): Capability {
  const spec = PROPERTIES[property];
  if (spec) return { property, access: 'read', ...spec };
  const label = property.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
  return { property, label, access: 'read', kind };
}

/** What the device reports, always with the link quality the central adds, in the catalogue's order. */
export function capabilitiesOf(properties: Record<string, PropertyKind>): Capability[] {
  const all: Record<string, PropertyKind> = { ...properties, linkquality: 'numeric' };
  return Object.keys(all)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((property) => capabilityOf(property, all[property]!));
}

const rank = (property: string) => (ORDER.includes(property) ? ORDER.indexOf(property) : ORDER.length);
