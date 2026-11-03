import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoveredCentrals, listZDevices, readingsOf } from '../src/store.ts';
import { recorder, setup } from './fakes.ts';

const MAC = 'aabbccddeeff';
const PING = { firmware: '2.0', protocol: 2, channel: 6 };
const REPORT = { temperature: 21.5, humidity: 40, linkquality: 180, model: 0x0102, firmware: '2.0', report_interval: 60 };

let current: ReturnType<typeof setup> | undefined;
afterEach(() => {
  current?.service.stop();
  current = undefined;
  vi.useRealTimers();
});

/** A service with central-1 discovered and attached to project p1. */
function attached() {
  current = setup();
  const { mqtt, service } = current;
  mqtt.deliver('broker', 'zdevices/central-1/bridge/info', PING);
  const handle = recorder();
  const detach = service.attach('p1', 'central-1', handle);
  return { ...current, handle, detach };
}

async function find(context: ReturnType<typeof attached>, central = 'central-1', devices = [{ id: MAC, model: 0x0102, properties: ['temperature', 'humidity'] }]) {
  const pending = context.service.commands.seen({ projectId: 'p1', central });
  const request = context.mqtt.lastOn(`zdevices/${central}/bridge/request/seen`)!;
  const { transaction } = request.payload as { transaction: string };
  context.mqtt.deliver('broker', `zdevices/${central}/bridge/response/seen`, { status: 'ok', transaction, data: devices }, central);
  return pending;
}

describe('discovery', () => {
  it('lists centrals from their pings and skips what the engine published', () => {
    current = setup();
    const { mqtt, storage } = current;
    expect(mqtt.listening('broker')).toBe(1);
    mqtt.deliver('broker', 'zdevices/central-2/bridge/info', PING, null);
    mqtt.deliver('broker', 'zdevices/central-1/bridge/info', PING);
    expect(discoveredCentrals(storage)).toMatchObject([{ central: 'central-1', connection: 'broker', online: true, info: PING }]);
    expect(discoveredCentrals(storage, undefined, Date.now() + 4 * 60_000)).toEqual([]);
  });

  it('follows the settings', () => {
    current = setup();
    const { mqtt, service } = current;
    service.update({ connections: [{ connection: 'other' }] });
    expect(mqtt.listening('broker')).toBe(0);
    expect(mqtt.listening('other')).toBe(1);
  });

  it('tells the attached integration when the central goes offline and back', () => {
    const { mqtt, handle } = attached();
    mqtt.disconnect('broker', 'central-1');
    mqtt.deliver('broker', 'zdevices/central-1/bridge/state', { state: 'online' });
    mqtt.deliver('broker', 'zdevices/central-1/bridge/info', PING);
    expect(handle.events).toEqual([
      { event: 'offline', central: 'central-1' },
      { event: 'online', central: 'central-1' },
    ]);
  });
});

describe('claims', () => {
  it('keeps a central in one project at a time', () => {
    const { service, storage, detach } = attached();
    expect(() => service.attach('p2', 'central-1', recorder())).toThrow(/another project/);
    expect(() => service.attach('p1', 'central-1', recorder())).toThrow(/already has/);
    expect(discoveredCentrals(storage)[0]?.projectId).toBe('p1');
    detach();
    expect(() => service.attach('p2', 'central-1', recorder())).not.toThrow();
  });

  it('only lets the same integration go', () => {
    const { service, detach } = attached();
    detach();
    const again = service.attach('p1', 'central-1', recorder());
    detach();
    expect(() => service.attach('p2', 'central-1', recorder())).toThrow(/another project/);
    again();
  });

  it('refuses commands for a central the project does not hold', async () => {
    const { service } = attached();
    await expect(service.commands.seen({ projectId: 'p2', central: 'central-1' })).rejects.toThrow(/isn't running/);
  });
});

describe('finding and adding devices', () => {
  it('asks the central, adds a device and sends it the relay list', async () => {
    const context = attached();
    const { mqtt, service, storage } = context;
    expect(mqtt.lastOn('zdevices/central-1/bridge/config/devices')).toMatchObject({ payload: { devices: [] }, retain: true });

    expect(await find(context)).toMatchObject([{ id: MAC, modelName: 'Weather station', state: 'new' }]);
    service.commands.add({ projectId: 'p1', central: 'central-1', id: MAC, name: 'Garden' });

    expect(mqtt.lastOn('zdevices/central-1/bridge/config/devices')?.payload).toEqual({ devices: [MAC] });
    expect(listZDevices(storage, 'p1')).toMatchObject([
      { id: MAC, name: 'Garden', model: 'Weather station', properties: ['Temperature', 'Humidity', 'Link quality'], relays: [{ central: 'central-1' }] },
    ]);
    expect(await find(context)).toMatchObject([{ state: 'relayed', name: 'Garden' }]);
  });

  it('times out when the central does not answer', async () => {
    vi.useFakeTimers();
    const { service } = attached();
    const pending = service.commands.seen({ projectId: 'p1', central: 'central-1' });
    vi.advanceTimersByTime(5_000);
    await expect(pending).rejects.toThrow(/didn't answer/);
  });

  it('keeps a device while another central relays it', async () => {
    const context = attached();
    const { mqtt, service, storage, iot } = context;
    mqtt.deliver('broker', 'zdevices/central-2/bridge/info', PING, 'central-2');
    service.attach('p1', 'central-2', recorder());
    await find(context);
    service.commands.add({ projectId: 'p1', central: 'central-1', id: MAC, name: 'Garden' });
    expect(await find(context, 'central-2')).toMatchObject([{ state: 'in-project' }]);
    service.commands.add({ projectId: 'p1', central: 'central-2', id: MAC });
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, seq: 1 });

    service.commands.remove({ projectId: 'p1', central: 'central-1', id: MAC });
    expect(mqtt.lastOn('zdevices/central-1/bridge/config/devices')?.payload).toEqual({ devices: [] });
    expect(listZDevices(storage, 'p1')).toMatchObject([{ name: 'Garden', relays: [{ central: 'central-2' }] }]);

    service.commands.remove({ projectId: 'p1', central: 'central-2', id: MAC });
    expect(iot.devices('p1')).toEqual([]);
    expect(readingsOf(storage.project('p1')).rows()).toEqual([]);
  });
});

describe('reports', () => {
  async function withDevice() {
    const context = attached();
    await find(context);
    context.service.commands.add({ projectId: 'p1', central: 'central-1', id: MAC, name: 'Garden' });
    return context;
  }

  it('reports the values to the registry and keeps a reading', async () => {
    const { mqtt, iot, storage } = await withDevice();
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, seq: 1 });
    expect(iot.device('p1', MAC)).toMatchObject({ online: true, state: { temperature: 21.5, humidity: 40, linkquality: 180 } });
    expect(readingsOf(storage.project('p1')).rows()).toMatchObject([
      { externalId: MAC, central: 'central-1', values: { temperature: 21.5, humidity: 40, linkquality: 180 } },
    ]);
  });

  it('drops a repeated seq unless the device booted', async () => {
    const { mqtt, storage } = await withDevice();
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, seq: 1 });
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, seq: 1 });
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, seq: 1, boot: true });
    expect(readingsOf(storage.project('p1')).rows()).toHaveLength(2);
  });

  it('adds the capabilities of new properties', async () => {
    const { mqtt, iot } = await withDevice();
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, battery: 80, seq: 1 });
    expect(iot.device('p1', MAC)?.capabilities.map((capability) => capability.property)).toEqual([
      'temperature',
      'humidity',
      'battery',
      'linkquality',
    ]);
  });

  it('ignores devices the central does not relay, telling the integration once', async () => {
    const { mqtt, handle, storage } = await withDevice();
    mqtt.deliver('broker', 'zdevices/central-1/112233445566', { ...REPORT, model: 0x0101, seq: 1 });
    mqtt.deliver('broker', 'zdevices/central-1/112233445566', { ...REPORT, model: 0x0101, seq: 2 });
    expect(handle.events).toEqual([{ event: 'unknown-device', central: 'central-1', device: '112233445566', model: 'Water detector' }]);
    expect(readingsOf(storage.project('p1')).rows()).toHaveLength(0);
  });

  it('marks a device offline once it misses its reports, and prunes old readings', async () => {
    const { mqtt, iot, service, storage } = await withDevice();
    mqtt.deliver('broker', `zdevices/central-1/${MAC}`, { ...REPORT, seq: 1 });
    service.checkAvailability(Date.now() + 179_000);
    expect(iot.device('p1', MAC)?.online).toBe(true);
    service.checkAvailability(Date.now() + 181_000);
    expect(iot.device('p1', MAC)?.online).toBe(false);

    service.applyRetention(Date.now() + 366 * 24 * 60 * 60_000);
    expect(readingsOf(storage.project('p1')).rows()).toHaveLength(0);
  });
});
