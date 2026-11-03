import {
  defineWidget,
  matchColor,
  rangeBounds,
  type ColorRule,
  type PropertySchema,
  type SeriesData,
  type TableStorage,
  type TimeRange,
  type TimelineData,
  type TimelineEntry,
  type WidgetDataContext,
} from '@zflow/sdk';
import { PROVIDER } from './catalogue.ts';
import { readingsOf, registryDevices } from './store.ts';
import { IOT, type Device } from './zflow-plugins.ts';

const CHART_POINTS = 120;
const LOOKBACK = 200;

const device: PropertySchema = { type: 'enum', label: 'Device', optionsFrom: 'zdevices.devices', required: true };
const propertyFrom = (source: string): PropertySchema => ({
  type: 'enum',
  label: 'Property',
  optionsFrom: `zdevices.${source}`,
  optionsDependOn: ['device'],
  required: true,
});
const label: PropertySchema = {
  type: 'string',
  label: 'Label',
  description: 'Empty uses the device and property',
  group: 'Display',
};
const icon: PropertySchema = { type: 'string', format: 'icon', label: 'Icon', group: 'Display' };

export function deviceSeries(storage: TableStorage, externalId: string, property: string, range: TimeRange) {
  const table = readingsOf(storage);
  const query = { ...rangeBounds(range), where: { externalId }, column: 'values', path: property };
  return {
    points: table.series({ ...query, buckets: CHART_POINTS }),
    min: table.series({ ...query, fn: 'min', buckets: 1 })[0]?.value ?? null,
    max: table.series({ ...query, fn: 'max', buckets: 1 })[0]?.value ?? null,
  };
}

export function deviceActivity(storage: TableStorage, externalId: string, property: string, limit: number) {
  return readingsOf(storage)
    .rows({ where: { externalId }, order: 'desc', limit: LOOKBACK })
    .filter((row) => (row.values as Record<string, unknown> | null)?.[property] !== undefined)
    .slice(0, Math.max(1, limit))
    .map((row): TimelineEntry => {
      const raw = (row.values as Record<string, unknown>)[property];
      return { at: row.at, value: typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw) };
    });
}

export const historyWidget = defineWidget({
  id: 'zdevices.history',
  name: 'Z Device history',
  description: 'Charts a Z Device reading over time, like a temperature over the last day',
  icon: 'chart-line',
  template: 'templates.series',
  width: 'medium',
  rows: 4,
  refreshMs: 60_000,
  appearance: true,
  properties: {
    device,
    property: propertyFrom('numeric'),
    range: {
      type: 'enum',
      label: 'Range',
      default: '1440',
      options: [
        { value: '60', label: 'Last hour' },
        { value: '360', label: 'Last 6 hours' },
        { value: '1440', label: 'Last 24 hours' },
        { value: '10080', label: 'Last 7 days' },
        { value: '43200', label: 'Last 30 days' },
        { value: '525600', label: 'Last year' },
      ],
    },
    rangePicker: {
      type: 'boolean',
      label: 'Viewers can change the range',
      description: "Their choice only changes what they see and isn't saved",
      default: true,
    },
    label,
    icon,
  },
  data(ctx): SeriesData {
    const { config } = ctx;
    const { device, property, capability, storage } = selected(ctx);
    const rangePicker = config.rangePicker !== false;
    const range = (rangePicker && ctx.range) || { minutes: Number(config.range) };
    const value = device.state[property];
    return {
      label: labelOf(config, device, capability?.label ?? property),
      ...optional({ icon: config.icon, unit: capability?.unit }),
      value: typeof value === 'number' ? value : null,
      ...(device.lastSeen !== undefined && { at: device.lastSeen, stale: device.online === false }),
      ...deviceSeries(storage, device.externalId, property, range),
      range,
      rangePicker,
    };
  },
});

export const activityWidget = defineWidget({
  id: 'zdevices.activity',
  name: 'Z Device activity',
  description: 'Lists what a Z Device reported lately, like each time it detected water',
  icon: 'list',
  template: 'templates.timeline',
  rows: 4,
  refreshMs: 30_000,
  appearance: true,
  properties: {
    device,
    property: propertyFrom('properties'),
    limit: { type: 'number', label: 'Entries', description: 'How many of the latest values to list', default: 10 },
    label,
    icon,
  },
  data(ctx): TimelineData {
    const { config } = ctx;
    const { device, property, capability, storage } = selected(ctx);
    const rules = (config.colors ?? []) as ColorRule[];
    return {
      label: labelOf(config, device, capability?.label ?? property),
      ...optional({ icon: config.icon, unit: capability?.unit }),
      entries: deviceActivity(storage, device.externalId, property, Number(config.limit) || 10).map((entry) => ({
        ...entry,
        ...optional({ color: matchColor(rules, entry.value) }),
      })),
    };
  },
});

function selected({ config, project }: WidgetDataContext) {
  if (!project) throw new Error('Z Device widgets show the devices of their project');
  const id = config.device as string;
  const device = registryDevices(project.storage(IOT), project.id).find((candidate) => candidate.id === id);
  if (!device || device.provider !== PROVIDER) throw new Error("The device isn't in the project anymore. Pick another one");
  const property = config.property as string;
  const capability = device.capabilities.find((candidate) => candidate.property === property);
  return { device, property, capability, storage: project.storage() };
}

const labelOf = (config: Record<string, unknown>, device: Device, property: string) =>
  (config.label as string | undefined) || `${device.name} ${property.toLowerCase()}`;

function optional(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  );
}
