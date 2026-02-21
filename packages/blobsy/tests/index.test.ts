import { describe, expect, it } from 'vitest';
import { YREF_FORMAT, isValidHash } from '../src/index.js';

describe('blobsy exports', () => {
  it('exports YREF_FORMAT constant', () => {
    expect(YREF_FORMAT).toBe('blobsy-yref/0.1');
  });

  it('exports isValidHash function', () => {
    expect(isValidHash('sha256:' + 'a'.repeat(64))).toBe(true);
    expect(isValidHash('invalid')).toBe(false);
  });
});
