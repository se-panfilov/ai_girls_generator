import { readFileSync } from 'node:fs';

import { humanoidGirlV1Groups, parseModule } from '@rig-runtime/modules';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { contract, fullSet, moduleFor } from './helpers';

// The JSON Schema documents the module format. parseModule is the run-time check; it also has the cross rules.
// This test keeps the two in agreement on the structural cases.
const schema = JSON.parse(readFileSync(new URL('../schemas/part-module.schema.json', import.meta.url), 'utf8')) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

describe('part module JSON Schema', () => {
  it('accepts every module made from the owner fixtures', () => {
    for (const item of (['a', 'b', 'c'] as const).flatMap((id) => fullSet(id))) expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ['unknown field', { extra: 1 }],
    ['bad schema id', { schema: 'aigg.part-module/9' }],
    ['bad side', { side: 'left' }],
    ['unsafe atlas path', { atlas: { file: '../x.atlas', sha256: '0'.repeat(64), pma: true, pages: [{ file: 'x.png', sha256: '0'.repeat(64) }] } }],
    ['absent binding with a region', { bindings: [{ slot: 'acc_head', status: 'absent_by_design', region: 'acc_head' }] }],
    ['provenance without source', { provenance: { tool: 'x' } }]
  ])('rejects %s in the schema and in parseModule', (_name, change) => {
    const item = { ...moduleFor('a', 'head_accessory'), ...change };
    expect(validate(item)).toBe(false);
    expect(() => parseModule(item, contract(), humanoidGirlV1Groups)).toThrow();
  });
});
