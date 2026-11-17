import { errorText, parsePageConfig, withTimeout } from '@viewer/pageconfig';
import { describe, expect, it } from 'vitest';

const valid = { skeleton: 'export/a.json', atlas: 'export/a.atlas', animations: ['idle', 'wave'], required: ['idle', 'wave'] };

describe('page configuration', () => {
  it('accepts relative export URLs and the required animations', () => {
    expect(parsePageConfig(valid)).toEqual(valid);
  });

  it('refuses absolute or parent URLs, wrong types, and missing animations', () => {
    for (const skeleton of ['https://example.com/a.json', '/export/a.json', 'export/../a.json', 'export/a b.json', 3]) {
      expect(typeof parsePageConfig({ ...valid, skeleton })).toBe('string');
    }
    expect(parsePageConfig({ ...valid, animations: ['idle'] })).toBe('The skeleton has no animation wave.');
    expect(typeof parsePageConfig([])).toBe('string');
    expect(typeof parsePageConfig({ ...valid, required: 'idle' })).toBe('string');
  });

  it('makes one safe status line from an error', () => {
    expect(errorText(new Error('a\u001b[31mb'))).toBe('Error: a?[31mb');
    expect(errorText(42)).toBe('Error: Unknown error.');
    expect(errorText('x'.repeat(1000)).length).toBe(607);
  });

  it('stops waiting after the time limit', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, 'late')).rejects.toThrow('late');
    await expect(withTimeout(Promise.resolve(5), 1000, 'late')).resolves.toBe(5);
    await expect(withTimeout(Promise.reject(new Error('bad')), 1000, 'late')).rejects.toThrow('bad');
  });
});
