import { afterEach, describe, expect, it } from 'vitest';
import { topics } from '../src/protocol.ts';
import { detailsOf, linksOf, listZDevices } from '../src/store.ts';
import { setup } from './fakes.ts';

const MAC = 'a0b765000101';
let running: ReturnType<typeof setup> | undefined;

function start(settings?: unknown) {
  running = setup(settings);
  return running;
}

afterEach(() => {
  running?.service.stop();
  running = undefined;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A running service with central-1 heard and paired. */
function withCentral() {
  const env = start();
  env.mqtt.deliver('broker', 'zdevices/central-1/bridge/info', { firmware: '2.0', channel: 6 });
  env.service.commands.pairCentral({ central: 'central-1' });
  return env;
}

/** Opens pairing and has central-1 answer that it heard the given devices. */
async function heard(env: ReturnType<typeof setup>, data: unknown[]) {
  env.service.commands.permitJoin({});
  const request = env.mqtt.lastOn(topics.seenRequest('central-1'))!;
  const { transaction } = request.payload as { transaction: string };
  env.mqtt.deliver('broker', 'zdevices/central-1/bridge/response/seen', { status: 'ok', transaction, data });
  await flush();
}

async function withDevice() {
  const env = withCentral();
  await heard(env, [{ id: MAC, model: 0x0102, properties: ['temperature'], report_interval: 60, linkquality: 150 }]);
  env.service.commands.pair({ id: MAC, name: 'Kitchen' });
  return env;
}

describe('service lifecycle', () => {
  it('stays off until enabled with a broker, and follows setting changes', () => {
    const { service, mqtt } = start({ enabled: false, connection: 'broker' });
    expect(service.status().state).toBe('off');
    expect(mqtt.listening('broker')).toBe(0);

    service.update({ enabled: true, connection: 'broker' });
    expect(service.status().state).toBe('running');
    expect(mqtt.listening('broker')).toBe(1);

    service.update({ enabled: true, connection: 'other' });
    expect(mqtt.listening('broker')).toBe(0);
    expect(mqtt.listening('other')).toBe(1);

    service.update({ enabled: false, connection: 'other' });
    expect(service.status().state).toBe('off');
    expect(mqtt.listening('other')).toBe(0);
  });
});

describe('centrals', () => {
  it('lists the heard ones, pairs them and sends them the relay list', () => {
    const { service, mqtt, storage } = start();
    expect(() => service.commands.pairCentral({ central: 'central-1' })).toThrow(/heard/);

    mqtt.deliver('broker', 'zdevices/central-1/bridge/info', { firmware: '2.0', channel: 6 });
    expect(service.status().centrals).toEqual([
      expect.objectContaining({ central: 'central-1', paired: false, online: true, info: { firmware: '2.0', channel: 6 } }),
    ]);
    expect(mqtt.lastOn(topics.relays('central-1'))).toBeUndefined();

    service.commands.pairCentral({ central: 'central-1' });
    expect(service.status().centrals[0]).toMatchObject({ paired: true });
    expect(mqtt.lastOn(topics.relays('central-1'))).toMatchObject({ payload: { devices: [] }, retain: true });

    mqtt.deliver('broker', 'zdevices/central-1/bridge/state', { state: 'offline' });
    expect(service.status().centrals[0]).toMatchObject({ online: false });

    linksOf(storage).put({ central: 'central-1', externalId: MAC });
    service.commands.unpairCentral({ central: 'central-1' });
    expect(service.status().centrals[0]).toMatchObject({ paired: false });
    expect(linksOf(storage).rows()).toEqual([]);
  });

  it('ignores what the engine itself published', () => {
    const { service, mqtt } = start();
    mqtt.deliver('broker', 'zdevices/central-1/bridge/info', { firmware: '2.0' }, null);
    expect(service.status().centrals).toEqual([]);
  });
});

describe('pairing devices', () => {
  it('needs an online paired central', () => {
    const { service } = start();
    expect(() => service.commands.permitJoin({})).toThrow(/Pair a central/);
  });

  it('lists what the centrals heard, and pairs a device on every paired central', async () => {
    const env = withCentral();
    env.mqtt.deliver('broker', 'zdevices/central-2/bridge/info', {}, 'central-2');
    env.service.commands.pairCentral({ central: 'central-2' });
    await heard(env, [{ id: MAC, model: 0x0102, properties: ['temperature', 'humidity'], linkquality: 150 }]);

    const status = env.service.status();
    expect(status.joinUntil).toBeGreaterThan(Date.now());
    expect(status.pairing).toEqual([
      expect.objectContaining({ id: MAC, model: 0x0102, properties: ['temperature', 'humidity'], heardBy: [{ central: 'central-1', linkquality: 150 }] }),
    ]);

    const device = env.service.commands.pair({ id: MAC, name: 'Kitchen' });
    expect(device).toMatchObject({ name: 'Kitchen', externalId: MAC });
    expect(env.service.status().pairing).toEqual([]);
    await flush();
    for (const central of ['central-1', 'central-2']) {
      expect(env.mqtt.lastOn(topics.relays(central))?.payload).toEqual({ devices: [MAC] });
    }

    const listed = listZDevices(env.storage)[0]!;
    expect(listed).toMatchObject({ name: 'Kitchen', details: { externalId: MAC, model: 0x0102 } });
    expect(listed.links).toEqual([expect.objectContaining({ central: 'central-1', linkquality: 150 })]);
    expect(listed.capabilities.map((capability) => capability.property)).toEqual(['temperature', 'humidity', 'linkquality']);
  });

  it('refuses a device no central heard', () => {
    const { service } = withCentral();
    expect(() => service.commands.pair({ id: MAC, name: 'Kitchen' })).toThrow(/heard/);
  });
});

describe('reports', () => {
  it('keeps the state and the link, once per seq', async () => {
    const env = await withDevice();
    env.mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { temperature: 21.5, linkquality: 140, seq: 1 });
    env.mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { temperature: 21.5, linkquality: 140, seq: 1 });

    expect(env.iot.device(MAC)).toMatchObject({ online: true, state: { temperature: 21.5, linkquality: 140 } });
    expect(env.iot.reports).toBe(1);
    expect(linksOf(env.storage).rows()).toEqual([expect.objectContaining({ central: 'central-1', linkquality: 140 })]);
    expect(detailsOf(env.storage).rows()[0]).toMatchObject({ lastSeq: 1, lastCentral: 'central-1' });
  });

  it('ignores unpaired centrals and devices', async () => {
    const env = await withDevice();
    env.mqtt.deliver('broker', 'zdevices/central-9/bridge/info', {}, 'central-9');
    env.mqtt.deliver('broker', `zdevices/central-9/${MAC}`, { temperature: 30, seq: 2 }, 'central-9');
    env.mqtt.deliver('broker', 'zdevices/central-1/a0b765000199', { temperature: 30, seq: 2 });
    expect(env.iot.reports).toBe(0);
    expect(env.iot.device('a0b765000199')).toBeUndefined();
  });

  it('marks a device offline after two report intervals plus a minute', async () => {
    const env = await withDevice();
    env.mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { temperature: 21.5, seq: 1 });
    const reported = detailsOf(env.storage).rows()[0]!.lastReport as number;
    env.service.checkAvailability(reported + 180_000);
    expect(env.iot.device(MAC)?.online).toBe(true);
    env.service.checkAvailability(reported + 180_001);
    expect(env.iot.device(MAC)?.online).toBe(false);
  });
});

describe('removing and history', () => {
  it('removes a device and drops it from the relay list', async () => {
    const env = await withDevice();
    env.mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { temperature: 21.5, seq: 1 });
    env.service.commands.remove({ id: MAC });
    expect(listZDevices(env.storage)).toEqual([]);
    expect(linksOf(env.storage).rows()).toEqual([]);
    expect(env.mqtt.lastOn(topics.relays('central-1'))?.payload).toEqual({ devices: [] });
  });

  it('has the registry keep history for the set days, or forever when empty', () => {
    const { iot, service } = start();
    expect(iot.history).toEqual({ days: 365 });
    service.update({ enabled: true, connection: 'broker', historyDays: '' });
    expect(iot.history).toEqual({});
  });
});
