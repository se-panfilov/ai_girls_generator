import { readFileSync } from 'node:fs';

import { parseManifest } from '@factory/manifest';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

// The JSON Schema documents job.json. parseManifest is the run-time check. This test keeps the two in agreement.
const schema = JSON.parse(readFileSync(new URL('../schemas/job.schema.json', import.meta.url), 'utf8')) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const example = JSON.parse(readFileSync(new URL('../examples/job.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('job manifest JSON Schema', () => {
  it('accepts the example in the schema and in parseManifest', () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(parseManifest(example).jobId).toBe('example-character');
  });

  it.each([
    ['unknown field', { extra: 1 }],
    ['bad format', { format: 'aigg.factory.job/9' }],
    ['bad job id', { jobId: '../x' }],
    ['bad approval', { approvals: [{ checkpoint: 'M', decision: 'approved', digest: '0'.repeat(64), artifactVersion: '', by: 'x', note: '', at: '', tool: '' }] }],
    ['bad spine version', { tools: { spine: { path: '/x', version: 'any' }, controlCli: null, viewerCli: null } }]
  ])('rejects %s in the schema and in parseManifest', (_name, change) => {
    const item = { ...example, ...change };
    expect(validate(item)).toBe(false);
    expect(() => parseManifest(item)).toThrow();
  });

  it('rejects an output folder outside the job in the schema and in parseManifest', () => {
    const item = structuredClone(example) as { stages: { M: { output: { dir: string } } } };
    item.stages.M.output.dir = '../../outside/out';
    expect(validate(item)).toBe(false);
    expect(() => parseManifest(item)).toThrow(/run folder/);
  });
});
