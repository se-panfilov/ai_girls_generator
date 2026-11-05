import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { parseRigContract } from '@rig-runtime/contract';
import { moduleGroupProblems } from '@rig-runtime/modules';
import { describe, expect, it } from 'vitest';

import { makeSyntheticAssets, spikeGroups } from './d26/assets';
import { deriveFixtureTexts, l1Dir, readSpikeFile, spikeDir } from './d26/fixture';
import { loadSpike } from './d26/setup';

// D26 spike: the isolated fixture. Set AIGG_D26_WRITE_FIXTURE=1 to write the derived files after a change of test/d26/fixture.ts.

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

describe('D26 spike fixture', () => {
  it('the committed fixture is the exact output of the derivation from the L1 export', () => {
    const texts = deriveFixtureTexts();
    if (process.env.AIGG_D26_WRITE_FIXTURE === '1') {
      writeFileSync(`${spikeDir}skeleton.json`, texts.skeleton);
      writeFileSync(`${spikeDir}rig.contract.json`, texts.contract);
    }
    expect(readSpikeFile('skeleton.json')).toBe(texts.skeleton);
    expect(readSpikeFile('rig.contract.json')).toBe(texts.contract);
  });

  it('the L1 owner files and the production contract stay unchanged', () => {
    const sums = readFileSync(`${l1Dir}SHA256SUMS`, 'utf8').trim().split('\n');
    for (const line of sums) {
      const [hash, path] = line.split(/\s+/);
      expect(sha256(readFileSync(`${l1Dir}${path}`)), path).toBe(hash);
    }
    expect(readFileSync(new URL('../../../docs/RIG_CONTRACT.md', import.meta.url), 'utf8')).not.toContain('eyes');
  });

  it('adds slot eyes above head, moves the tail keys out of run and jump_air, and adds tail and blink animations', () => {
    const skeleton = JSON.parse(readSpikeFile('skeleton.json')) as { slots: { name: string }[]; animations: Record<string, { bones?: Record<string, unknown> }> };
    const names = skeleton.slots.map((slot) => slot.name);
    expect(names.indexOf('eyes')).toBe(names.indexOf('head') + 1);
    expect(names.indexOf('eyes')).toBeLessThan(names.indexOf('hair_front'));
    expect(skeleton.animations.run?.bones?.tail_1).toBeUndefined();
    expect(skeleton.animations.jump_air?.bones?.tail_1).toBeUndefined();
    const l1 = JSON.parse(readFileSync(`${l1Dir}editor-out/skeleton.json`, 'utf8')) as typeof skeleton;
    // The movement is kept: the same keys, now in the tail animations.
    expect(skeleton.animations.tail_run?.bones?.tail_1).toEqual(l1.animations.run?.bones?.tail_1);
    expect(skeleton.animations.tail_jump?.bones?.tail_1).toEqual(l1.animations.jump_air?.bones?.tail_1);
    expect(Object.keys(skeleton.animations).sort()).toEqual([...Object.keys(l1.animations), 'blink', 'tail_idle', 'tail_jump', 'tail_run'].sort());
  });

  it('the spike contract is a valid runtime contract with a new rig id', () => {
    const contract = parseRigContract(JSON.parse(readSpikeFile('rig.contract.json')));
    expect(contract.rigId).toBe('humanoid_girl_v1_d26_spike');
    expect(contract.slots.find((slot) => slot.id === 'eyes')).toMatchObject({ bone: 'head', required: false, attachmentRect: { w: 140, h: 48 } });
  });

  it('the experimental group table covers every slot except eyes (production gap: sequence slots in modules)', () => {
    const { rig } = loadSpike();
    expect(moduleGroupProblems(rig.contract, spikeGroups).map((item) => `${item.code}:${item.subject}`)).toEqual(['E_GROUP_TABLE:eyes']);
  });

  it('the synthetic assets are deterministic', () => {
    const { rig } = loadSpike();
    const first = makeSyntheticAssets(rig);
    const second = makeSyntheticAssets(rig);
    const digest = (files: ReadonlyMap<string, string | Buffer>): Record<string, string> => Object.fromEntries([...files].map(([path, data]) => [path, sha256(data)]));
    expect(digest(second.files)).toEqual(digest(first.files));
    expect([...first.files.keys()].sort()).toEqual(['body.atlas', 'body.png', 'eyes.atlas', 'eyes.png', 'hair_a.atlas', 'hair_a.png', 'hair_b.atlas', 'hair_b.png', 'tail.atlas', 'tail.png']);
    // The closed-eye frame is trimmed by the packer, so the offsets path of the frame geometry is tested.
    expect(String(first.files.get('eyes.atlas'))).toContain('eyes_2\nbounds:');
    expect(String(first.files.get('eyes.atlas'))).toMatch(/eyes_2\nbounds:\d+,\d+,80,4\noffsets:30,10,140,48/);
  });
});
