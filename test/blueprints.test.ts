import type { BlueprintDefinition, OptionsContext } from '@zflow/sdk';
import { describe, expect, it } from 'vitest';
import { blueprintOptions, blueprints } from '../src/blueprints.ts';
import plugin from '../src/index.ts';
import { capabilitiesOf } from '../src/catalogue.ts';
import { FakeIot, memoryStorage } from './fakes.ts';

/** Every `"<page>.<field>"` a blueprint's placeholders read, from `$input`, `$when.input` and `{{…}}` in `$text`. */
function answersRead(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => answersRead(entry, found));
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$input === 'string') found.add(record.$input);
    if (typeof record.input === 'string') found.add(record.input);
    if (typeof record.$text === 'string') {
      for (const [, ref] of record.$text.matchAll(/{{\s*([\w-]+\.[\w-]+)(?:\.label)?\s*}}/g)) found.add(ref!);
    }
    Object.values(record).forEach((entry) => answersRead(entry, found));
  }
  return found;
}

const asked = (blueprint: BlueprintDefinition) =>
  new Set(blueprint.pages.flatMap((page) => Object.keys(page.properties).map((field) => `${page.id}.${field}`)));

describe('blueprints', () => {
  it.each(blueprints.map((blueprint) => [blueprint.id, blueprint]))('%s only reads fields its pages ask', (_, blueprint) => {
    const fields = asked(blueprint);
    expect([...answersRead(blueprint)].filter((field) => !field.startsWith('item.') && !fields.has(field))).toEqual([]);
  });

  it('only requires plugins it declares as dependencies', () => {
    const declared = Object.keys(plugin.dependencies ?? {});
    for (const blueprint of blueprints) {
      expect(declared).toEqual(expect.arrayContaining([...((blueprint.requires as string[] | undefined) ?? [])]));
    }
  });

  it('offers the paired devices that report the property', () => {
    const storage = memoryStorage();
    const iot = new FakeIot(storage.of('iot'));
    const add = (externalId: string, name: string, properties: string[]) =>
      iot.upsert('zdevices', {
        externalId,
        name,
        type: 'sensor',
        capabilities: capabilitiesOf(Object.fromEntries(properties.map((property) => [property, 'numeric']))),
      });
    add('b', 'Basement', ['water_leak', 'battery']);
    add('a', 'Attic', ['water_leak', 'battery']);
    add('m', 'Mains', ['power', 'energy']);
    const ctx = { storage, settings: {}, values: {} } as OptionsContext;

    expect(blueprintOptions.detectors(ctx)).toEqual([
      { value: 'zdevices:a', label: 'Attic' },
      { value: 'zdevices:b', label: 'Basement' },
    ]);
    expect(blueprintOptions.meters(ctx)).toEqual([{ value: 'zdevices:m', label: 'Mains' }]);
    expect(blueprintOptions.tanks(ctx)).toEqual([]);
  });
});
