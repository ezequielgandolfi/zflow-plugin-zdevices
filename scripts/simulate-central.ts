// A fake Z Central speaking protocol v2 over MQTT, for trying the plugin without firmware:
//   node scripts/simulate-central.ts mqtt://localhost:1883 [central-id] [username] [password]
import mqtt from 'mqtt';

const [url = 'mqtt://localhost:1883', central = 'central-sim', username, password] = process.argv.slice(2);
const base = `zdevices/${central}`;
const startedAt = Date.now();

interface FakeDevice {
  id: string;
  model: number;
  interval: number;
  batteryPowered: boolean;
  values: () => Record<string, number | boolean>;
}

const around = (value: number, spread: number) => Math.round((value + (Math.random() - 0.5) * spread) * 10) / 10;

const DEVICES: FakeDevice[] = [
  { id: 'a0b765000101', model: 0x0101, interval: 1800, batteryPowered: true, values: () => ({ water_leak: Math.random() < 0.05, battery: 87 }) },
  {
    id: 'a0b765000102',
    model: 0x0102,
    interval: 60,
    batteryPowered: true,
    values: () => ({ temperature: around(21, 2), humidity: around(48, 6), pressure: around(1013, 4), battery: 64 }),
  },
  {
    id: 'a0b765000103',
    model: 0x0103,
    interval: 30,
    batteryPowered: false,
    values: () => ({ power: around(320, 80), voltage: around(220, 4), current: around(1.4, 0.4), energy: 1234.5, ac_frequency: 50, power_factor: 0.94 }),
  },
  { id: 'a0b765000104', model: 0x0104, interval: 60, batteryPowered: true, values: () => ({ distance: around(42, 3), battery: 91 }) },
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
      dropped: 0,
      uptime: Math.round((Date.now() - startedAt) / 1000),
    },
    true,
  );

client.on('connect', () => {
  console.log(`${central} connected to ${url}`);
  send('bridge/state', { state: 'online' }, true);
  ping();
  client.subscribe([`${base}/bridge/config/devices`, `${base}/bridge/request/+`], { qos: 1 });
});

client.on('message', (topic, buffer) => {
  const payload = JSON.parse(buffer.toString() || '{}') as Record<string, unknown>;
  if (topic === `${base}/bridge/config/devices`) {
    relayed = new Set((payload.devices as string[] | undefined) ?? []);
    console.log(`Relaying ${[...relayed].join(', ') || 'nothing'}`);
    ping();
  } else if (topic === `${base}/bridge/request/seen`) {
    const since = Date.now() / 1000 - Number(payload.since ?? 3600);
    const data = DEVICES.filter((device) => (lastSeen.get(device.id) ?? Date.now()) / 1000 >= since).map((device) => ({
      id: device.id,
      model: device.model,
      firmware: '2.0',
      battery_powered: device.batteryPowered,
      report_interval: device.interval,
      properties: Object.keys(device.values()),
      linkquality: 150 + Math.round(Math.random() * 80),
      last_seen: Math.round((lastSeen.get(device.id) ?? Date.now()) / 1000),
      relayed: relayed.has(device.id),
    }));
    send('bridge/response/seen', { status: 'ok', transaction: payload.transaction, data });
  } else if (topic === `${base}/bridge/request/restart`) {
    console.log('Restart asked; ignoring it');
  }
});

// Each device "broadcasts" on its interval; only relayed ones get a handshake reply and send their report.
function report(device: FakeDevice, boot: boolean) {
  lastSeen.set(device.id, Date.now());
  if (!relayed.has(device.id) || !client.connected) return;
  const next = ((seq.get(device.id) ?? 0) + 1) % 0x10000;
  seq.set(device.id, next);
  send(device.id, {
    ...device.values(),
    linkquality: 150 + Math.round(Math.random() * 80),
    seq: next,
    model: device.model,
    firmware: '2.0',
    report_interval: device.interval,
    boot,
  });
}

for (const device of DEVICES) {
  let first = true;
  const tick = () => {
    report(device, first && relayed.has(device.id));
    if (relayed.has(device.id)) first = false;
  };
  setTimeout(tick, 2_000);
  // Long intervals are sped up so the simulator shows something within minutes.
  setInterval(tick, Math.min(device.interval, 120) * 1000);
}
setInterval(ping, 60_000);

process.on('SIGINT', () => {
  send('bridge/state', { state: 'offline' }, true);
  client.end(false, {}, () => process.exit(0));
});
