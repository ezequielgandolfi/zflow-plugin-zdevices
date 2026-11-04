import {
  defineBlueprint,
  type BlueprintCondition,
  type BlueprintDefinition,
  type BlueprintPage,
  type OptionsContext,
  type PropertyOption,
  type PropertySchema,
} from '@zflow/sdk';
import { registryDevices } from './store.ts';
import { IOT } from './zflow-plugins.ts';

// What the blueprints build on, copied from zflow-types' BUILT-IN-PLUGINS.md and the built-ins' own blueprints.
const DASHBOARDS = 'dashboards';
const NOTIFY = 'notify';
const DEVICE_RUNNER = 'iot';
const DEVICE_TRIGGER = 'device';
const NOTIFY_RUNNER = 'notifications';

const CATEGORY = 'Z Devices';

/** Paired Z Devices that report a property, for blueprints to offer only the devices they fit. */
const devicesWith =
  (property: string) =>
  ({ storage }: OptionsContext): PropertyOption[] =>
    registryDevices(storage.of(IOT))
      .filter((device) => device.capabilities.some((capability) => capability.property === property))
      .map((device) => ({ value: device.id, label: device.name }))
      .sort((a, b) => a.label.localeCompare(b.label));

export const blueprintOptions = {
  detectors: devicesWith('water_leak'),
  tanks: devicesWith('distance'),
  meters: devicesWith('power'),
};

const literal = (value: unknown) => ({ kind: 'literal' as const, value });
const fromStart = { kind: 'ref' as const, nodeId: 'start', property: 'value' };

const devicePage = (id: string, label: string, source: keyof typeof blueprintOptions, more = {}): BlueprintPage => ({
  id,
  title: label,
  properties: {
    device: {
      type: 'enum',
      label,
      optionsFrom: `zdevices.${source}`,
      description: 'Paired on the Z Devices page',
      required: true,
    },
    ...more,
  },
});

const notifyPage = (message: string, maxPerHour?: number): BlueprintPage => ({
  id: 'notify',
  title: 'Notification',
  description: 'Added to the project’s Notifications integration',
  properties: {
    channel: { type: 'enum', label: 'Send by', optionsFrom: 'notify.channels', required: true },
    to: {
      type: 'string',
      label: 'To',
      description: 'Recipients separated by commas, like phone numbers with the country code for SMS',
      required: true,
    },
    message: { type: 'string', label: 'Message', default: message, required: true },
    maxPerHour: {
      type: 'number',
      label: 'At most per hour',
      description: 'Leave it empty for no limit besides the global one',
      ...(maxPerHour !== undefined && { default: maxPerHour }),
    },
  },
});

const dashboardPage: BlueprintPage = {
  id: 'dashboard',
  title: 'Dashboard',
  description: 'Pick a dashboard to add a group to, or create a new one',
  properties: {
    target: { type: 'enum', label: 'Dashboard', optionsFrom: 'dashboards.dashboards', default: 'new', required: true },
    name: { type: 'string', label: 'Name', required: true, visibleWhen: { target: ['new'] } },
  },
};

/** A device event, checked against `right`, sending the notification the blueprint adds when it passes. */
function alertBlueprint({
  property,
  operator,
  right,
  name,
}: {
  property: string;
  operator: string;
  right: unknown;
  name: string;
}): Pick<BlueprintDefinition, 'automations' | 'runners'> {
  const notification = { $text: name };
  return {
    automations: [
      {
        id: 'alert',
        name: notification,
        triggerType: DEVICE_TRIGGER,
        graph: {
          nodes: [
            { id: 'start', type: 'iot.device-event', label: 'Device event', position: { x: 0, y: 0 }, properties: {} },
            {
              id: 'check',
              type: 'logic.compare',
              label: 'Compare',
              position: { x: 308, y: 0 },
              properties: { left: fromStart, operator: literal(operator), right: literal(right) },
            },
            {
              id: 'send',
              type: 'notify.send',
              label: 'Send notification',
              position: { x: 616, y: 0 },
              properties: { notification: literal(notification) },
            },
          ],
          edges: [
            { id: 'start-check', source: 'start', sourceOutput: 'ok', target: 'check' },
            { id: 'check-send', source: 'check', sourceOutput: 'true', target: 'send' },
          ],
        },
      },
    ],
    runners: [
      {
        type: DEVICE_RUNNER,
        bindings: [
          {
            automationId: 'alert',
            config: { match: 'device', device: { $input: 'sensor.device' }, event: 'changed', property },
          },
        ],
      },
      {
        type: NOTIFY_RUNNER,
        config: {
          notifications: [
            {
              name: notification,
              channel: { $input: 'notify.channel' },
              to: { $input: 'notify.to' },
              message: { $text: '{{sensor.device.label}}: {{notify.message}}' },
              maxPerHour: { $input: 'notify.maxPerHour' },
            },
          ],
        },
      },
    ],
  };
}

export const leakAlert = defineBlueprint({
  id: 'zdevices.leak-alert',
  name: 'Water leak alert',
  description: 'Sends a notification when a water detector finds a leak',
  icon: 'droplets',
  category: CATEGORY,
  requires: [NOTIFY],
  pages: [devicePage('sensor', 'Water detector', 'detectors'), notifyPage('Water leak detected')],
  ...alertBlueprint({
    property: 'water_leak',
    operator: 'equal',
    right: true,
    name: '{{sensor.device.label}} leak',
  }),
});

export const lowWaterAlert = defineBlueprint({
  id: 'zdevices.low-water-alert',
  name: 'Low water alert',
  description: 'Sends a notification when a water level sensor measures the water too far down',
  icon: 'waves',
  category: CATEGORY,
  requires: [NOTIFY],
  pages: [
    devicePage('sensor', 'Water level sensor', 'tanks', {
      above: {
        type: 'number',
        label: 'Warn above (cm)',
        description: 'The sensor measures the distance down to the water, so more means less water',
        required: true,
      } satisfies PropertySchema,
    }),
    notifyPage('The water level is low', 1),
  ],
  ...alertBlueprint({
    property: 'distance',
    operator: 'greater',
    right: { $input: 'sensor.above' },
    name: '{{sensor.device.label}} low water',
  }),
});

const meter = { $input: 'meter.device' };
const has = (property: string): BlueprintCondition => ({ options: 'iot.numeric', values: { device: meter }, has: property });
const meterValue = (property: string, icon: string) => ({
  $when: has(property),
  type: 'iot.value',
  config: { device: meter, property, icon },
});

export const powerMeterDashboard = defineBlueprint({
  id: 'zdevices.power-meter',
  name: 'Power meter',
  description: 'Adds a power gauge, the energy, voltage and current, and a power chart of a power meter',
  icon: 'zap',
  category: CATEGORY,
  requires: [DASHBOARDS],
  pages: [
    devicePage('meter', 'Power meter', 'meters', {
      max: { type: 'number', label: 'Gauge maximum (W)', default: 3500, required: true },
      history: { type: 'boolean', label: 'Add a power chart', default: true },
    }),
    dashboardPage,
  ],
  dashboards: [
    {
      target: { $input: 'dashboard.target' },
      name: { $input: 'dashboard.name' },
      groups: [
        {
          title: { $input: 'meter.device', $label: true },
          widgets: [
            {
              $when: has('power'),
              type: 'iot.gauge',
              config: { device: meter, property: 'power', min: 0, max: { $input: 'meter.max' } },
              width: 'medium',
            },
            meterValue('energy', 'gauge'),
            meterValue('voltage', 'zap'),
            meterValue('current', 'activity'),
            {
              $when: { input: 'meter.history' },
              type: 'iot.history',
              config: { device: meter, property: 'power' },
              width: 'large',
            },
          ],
        },
      ],
    },
  ],
});

export const blueprints = [leakAlert, lowWaterAlert, powerMeterDashboard];
