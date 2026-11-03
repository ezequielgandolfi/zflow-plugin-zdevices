import { describe, expect, it } from 'vitest';
import { capabilitiesOf, propertyKinds } from '../src/catalogue.ts';
import { normalizeDeviceId, parseMessage } from '../src/protocol.ts';
import { asSettings, validateSettings } from '../src/settings.ts';

describe('parseMessage', () => {
  it('splits a report into values and protocol fields', () => {
    expect(
      parseMessage('zdevices/central-1/aabbccddeeff', {
        temperature: 21.5,
        water_leak: false,
        nested: { no: 1 },
        linkquality: 180,
        seq: 7,
        model: 258,
        firmware: '2.0',
        report_interval: 60,
        boot: true,
      }),
    ).toEqual({
      kind: 'report',
      central: 'central-1',
      device: 'aabbccddeeff',
      report: { values: { temperature: 21.5, water_leak: false }, linkquality: 180, seq: 7, model: 258, firmware: '2.0', reportInterval: 60, boot: true },
    });
  });

  it('reads the bridge topics', () => {
    expect(parseMessage('zdevices/c1/bridge/state', { state: 'offline' })).toEqual({ kind: 'state', central: 'c1', online: false });
    expect(parseMessage('zdevices/c1/bridge/info', { firmware: '2.0', channel: 6, ip: 3 })).toEqual({
      kind: 'info',
      central: 'c1',
      info: { firmware: '2.0', channel: 6 },
    });
    expect(
      parseMessage('zdevices/c1/bridge/response/seen', {
        status: 'ok',
        transaction: 't1',
        data: [{ id: 'AA:BB:CC:DD:EE:FF', model: 257, properties: ['water_leak', 3], last_seen: 1_700_000_000 }, { id: 'bad' }],
      }),
    ).toEqual({
      kind: 'seen',
      central: 'c1',
      transaction: 't1',
      devices: [
        { id: 'aabbccddeeff', model: 257, batteryPowered: false, properties: ['water_leak'], lastSeen: 1_700_000_000_000, relayed: false },
      ],
    });
    expect(parseMessage('zdevices/c1/bridge/response/seen', { status: 'error', transaction: 't1', error: 'busy' })).toMatchObject({
      error: 'busy',
    });
  });

  it('ignores what isn\'t protocol v2', () => {
    expect(parseMessage('other/c1/bridge/state', { state: 'online' })).toBeUndefined();
    expect(parseMessage('zdevices/c 1/bridge/state', { state: 'online' })).toBeUndefined();
    expect(parseMessage('zdevices/c1/bridge/state', 'online')).toBeUndefined();
    expect(parseMessage('zdevices/c1/bridge/config/devices', { devices: [] })).toBeUndefined();
    expect(parseMessage('zdevices/c1/aabbccddeeff/set', { on: true })).toBeUndefined();
    expect(parseMessage('zdevices/c1/not-a-mac', { temperature: 1 })).toBeUndefined();
  });
});

describe('normalizeDeviceId', () => {
  it('accepts MACs with separators and refuses anything else', () => {
    expect(normalizeDeviceId(' A0:B7:65:12:34:56 ')).toBe('a0b765123456');
    expect(() => normalizeDeviceId('a0b76512345')).toThrow(/12 hex/);
  });
});

describe('capabilities', () => {
  it('uses the catalogue, guesses unknown properties and always adds the link quality', () => {
    const capabilities = capabilitiesOf(propertyKinds({ battery: 80, water_leak: true, lux: 300, mode: 'eco' }));
    expect(capabilities.map((capability) => capability.property)).toEqual(['water_leak', 'battery', 'linkquality', 'lux', 'mode']);
    expect(capabilities.find((capability) => capability.property === 'battery')).toMatchObject({ unit: '%', health: 'battery', access: 'read' });
    expect(capabilities.find((capability) => capability.property === 'linkquality')).toMatchObject({ health: 'signal' });
    expect(capabilities.find((capability) => capability.property === 'water_leak')).toMatchObject({ kind: 'binary', on: true, off: false });
    expect(capabilities.find((capability) => capability.property === 'lux')).toMatchObject({ kind: 'numeric', label: 'Lux' });
    expect(capabilities.find((capability) => capability.property === 'mode')).toMatchObject({ kind: 'text' });
  });
});

describe('settings', () => {
  it('defaults the retention, keeps readings forever when empty and needs a broker once enabled', () => {
    expect(asSettings(undefined)).toEqual({ enabled: false, connection: '', historyDays: 365 });
    expect(asSettings({ historyDays: '' }).historyDays).toBeUndefined();
    expect(asSettings({ historyDays: '30' }).historyDays).toBe(30);
    expect(validateSettings({ historyDays: 0 })).toHaveLength(1);
    expect(validateSettings({ enabled: true })).toEqual(['Pick the MQTT broker the centrals publish to']);
    expect(validateSettings({ enabled: true, connection: 'broker', historyDays: null })).toEqual([]);
  });
});
