// A fake Z Central speaking protocol v2 over MQTT, for trying the plugin without firmware:
//   node scripts/simulate-central.ts mqtt://localhost:1883 [central-id] [username] [password]
import mqtt from 'mqtt';

const [url = 'mqtt://localhost:1883', central = 'central-sim', username, password] = process.argv.slice(2);
const base = `zdevices/${central}`;
const startedAt = Date.now();

// Every device reports at a random moment within 1–2 minutes and announces 2 minutes as its interval, so it never
// looks offline. A command waits in the central for COMMAND_DELAY before the device's receive window takes it.
const REPORT_INTERVAL = 120;
const MIN_REPORT_GAP = 60;
const COMMAND_DELAY = 10_000;

interface FakeDevice {
  id: string;
  model: number;
  name: string;
  batteryPowered: boolean;
  values: () => Record<string, number | boolean | string>;
}

// The switch's state, changed only by commands, and the commands waiting for each device's receive window.
let switchState = 'OFF';
const WRITABLE = new Set(['state']);
const pending = new Map<string, Record<string, unknown>>();
const delivering = new Set<string>();

const log = (message: string) => console.log(`${new Date().toLocaleTimeString()}  ${message}`);
const describe = (values: Record<string, unknown>) =>
  Object.entries(values)
    .map(([property, value]) => `${property} ${String(value)}`)
    .join(', ');

const around = (value: number, spread: number) => Math.round((value + (Math.random() - 0.5) * spread) * 10) / 10;

let energy = 1234.5;

const DEVICES: FakeDevice[] = [
  {
    id: 'a0b765000101',
    model: 0x0101,
    name: 'Water detector',
    batteryPowered: true,
    values: () => ({ water_leak: Math.random() < 0.1, battery: Math.round(around(87, 2)) }),
  },
  {
    id: 'a0b765000102',
    model: 0x0102,
    name: 'Weather station',
    batteryPowered: true,
    values: () => ({ temperature: around(21, 2), humidity: around(48, 6), pressure: around(1013, 4), battery: 64 }),
  },
  {
    id: 'a0b765000103',
    model: 0x0103,
    name: 'Power meter',
    batteryPowered: false,
    values: () => {
      const power = around(320, 80);
      energy = Math.round((energy + (power * REPORT_INTERVAL) / 3_600_000) * 1000) / 1000;
      return { power, voltage: around(220, 4), current: around(1.4, 0.4), energy, ac_frequency: 50, power_factor: around(0.94, 0.04) };
    },
  },
  {
    id: 'a0b765000104',
    model: 0x0104,
    name: 'Water level',
    batteryPowered: true,
    values: () => ({ distance: around(42, 6), battery: 91 }),
  },
  { id: 'a0b765000105', model: 0x0105, name: 'Switch', batteryPowered: true, values: () => ({ state: switchState, battery: 78 }) },
];

let relayed = new Set<string>();
const seq = new Map<string, number>();
const lastSeen = new Map<string, number>();

const client = mqtt.connect(url, {
  clientId: central,
  ...(username && { username }),
  ...(password && { password }),
  will: { topic: `${base}/bridge/state`, payload: Buffer.from(JSON.stringify({ state: 'offline' })), qos: 1, retain: true },
});

const send = (topic: string, payload: unknown, retain = false) =>
  client.publish(`${base}/${topic}`, JSON.stringify(payload), { qos: topic.startsWith('bridge/') ? 1 : 0, retain });

const ping = () =>
  send(
    'bridge/info',
    {
      firmware: '2.0-sim',
      protocol: 2,
      channel: 6,
      mac: 'a0:b7:65:00:00:00',
      ip: '127.0.0.1',
      relaying: relayed.size,
      pending: pending.size,
      dropped: 0,
      uptime: Math.round((Date.now() - startedAt) / 1000),
    },
    true,
  );

client.on('connect', () => {
  log(`${central} connected to ${url}`);
  send('bridge/state', { state: 'online' }, true);
  ping();
  client.subscribe([`${base}/bridge/config/devices`, `${base}/bridge/request/+`, `${base}/+/set`], { qos: 1 });
});

client.on('message', (topic, buffer) => {
  const payload = JSON.parse(buffer.toString() || '{}') as Record<string, unknown>;
  if (topic === `${base}/bridge/config/devices`) {
    relayed = new Set((payload.devices as string[] | undefined) ?? []);
    log(`Relaying ${[...relayed].join(', ') || 'nothing'}`);
    ping();
  } else if (topic === `${base}/bridge/request/seen`) {
    const since = Date.now() / 1000 - Number(payload.since ?? 3600);
    const data = DEVICES.filter((device) => (lastSeen.get(device.id) ?? Date.now()) / 1000 >= since).map((device) => ({
      id: device.id,
      model: device.model,
      firmware: '2.0',
      battery_powered: device.batteryPowered,
      report_interval: REPORT_INTERVAL,
      properties: Object.keys(device.values()),
      linkquality: 150 + Math.round(Math.random() * 80),
      last_seen: Math.round((lastSeen.get(device.id) ?? Date.now()) / 1000),
      relayed: relayed.has(device.id),
    }));
    send('bridge/response/seen', { status: 'ok', transaction: payload.transaction, data });
  } else if (topic === `${base}/bridge/request/restart`) {
    log('Restart asked; ignoring it');
  } else if (topic.endsWith('/set')) {
    command(topic.slice(base.length + 1, -'/set'.length), payload);
  }
});

// Each device "broadcasts" when it wakes; only relayed ones get a handshake reply and send their report.
function report(device: FakeDevice, boot: boolean) {
  lastSeen.set(device.id, Date.now());
  const values = device.values();
  if (!relayed.has(device.id)) return log(`${device.name} ${device.id} heard, not relayed`);
  if (!client.connected) return log(`${device.name} ${device.id} report dropped: not connected`);
  const next = ((seq.get(device.id) ?? 0) + 1) % 0x10000;
  seq.set(device.id, next);
  send(device.id, {
    ...values,
    linkquality: 150 + Math.round(Math.random() * 80),
    seq: next,
    model: device.model,
    firmware: '2.0',
    report_interval: REPORT_INTERVAL,
    boot,
  });
  log(`${device.name} ${device.id} reported ${describe(values)}`);
}

/** Holds the command as the central would, then has the device wake, take it in its receive window and report. */
function command(id: string, payload: Record<string, unknown>) {
  const device = DEVICES.find((candidate) => candidate.id === id);
  log(`Command received for ${device?.name ?? 'unknown device'} ${id}: ${JSON.stringify(payload)}`);
  const values = Object.fromEntries(Object.entries(payload).filter(([property]) => WRITABLE.has(property)));
  if (!device || !relayed.has(id)) return log('  ignored: not relayed by this central');
  if (Object.keys(values).length === 0) return log('  ignored: nothing writable in it');
  pending.set(id, { ...pending.get(id), ...values });
  log(`  held for ${COMMAND_DELAY / 1000} s, until the device's receive window`);
  if (delivering.has(id)) return;
  delivering.add(id);
  setTimeout(() => {
    delivering.delete(id);
    const held = pending.get(id);
    pending.delete(id);
    if (!held) return;
    if (held.state !== undefined) {
      switchState = held.state === true || held.state === 1 || held.state === 'ON' ? 'ON' : 'OFF';
    }
    log(`${device.name} ${id} applied ${describe(held)}`);
    report(device, false);
  }, COMMAND_DELAY);
}

for (const device of DEVICES) {
  let first = true;
  const tick = () => {
    report(device, first && relayed.has(device.id));
    if (relayed.has(device.id)) first = false;
    const gap = MIN_REPORT_GAP + Math.random() * (REPORT_INTERVAL - MIN_REPORT_GAP);
    setTimeout(tick, gap * 1000);
  };
  setTimeout(tick, 2_000 + Math.random() * 3_000);
}
setInterval(ping, 60_000);

process.on('SIGINT', () => {
  send('bridge/state', { state: 'offline' }, true);
  client.end(false, {}, () => process.exit(0));
});
