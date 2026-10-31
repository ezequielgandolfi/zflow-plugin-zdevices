import { describe, expect, it } from 'vitest';
import { deviceTypeOf, normalizeId, toDeviceInput } from '../src/device-types.ts';

describe('normalizeId', () => {
  it('keeps MAC addresses lowercase and without colons', () => {
    expect(normalizeId(' A0:B7:65:12:34:56 ')).toBe('a0b765123456');
  });

  it('refuses empty ids', () => {
    expect(() => normalizeId('  ')).toThrow(/id/);
    expect(() => normalizeId(undefined)).toThrow(/id/);
  });
});

describe('deviceTypeOf', () => {
  it('accepts ids sent as text', () => {
    expect(deviceTypeOf('1002').name).toBe('Weather station');
  });

  it('refuses types outside Z Devices', () => {
    expect(() => deviceTypeOf(101)).toThrow(/Pick one of the device types/);
  });
});

describe('toDeviceInput', () => {
  it('turns a water detector status into an on/off reading', () => {
    expect(toDeviceInput('a1', 'Basement', deviceTypeOf(1001)).capabilities).toEqual([
      { property: 'status', label: 'Status', access: 'read', kind: 'binary', on: 1, off: 0 },
    ]);
  });

  it('turns sensors into read-only numeric properties with their range, precision and unit', () => {
    const input = toDeviceInput('a2', 'Garden', deviceTypeOf(1002));
    expect(input).toMatchObject({ externalId: 'a2', name: 'Garden', type: 'sensor', model: 'Weather station' });
    expect(input.capabilities[0]).toEqual({
      property: 'temperature',
      label: 'Temperature',
      access: 'read',
      kind: 'numeric',
      min: -50,
      max: 100,
      step: 0.1,
      unit: '°C',
    });
    expect(input.capabilities.map((capability) => capability.property)).toEqual(['temperature', 'humidity', 'pressure']);
  });
});
