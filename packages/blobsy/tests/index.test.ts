import { describe, expect, it } from 'vitest';
import { BREF_FORMAT, isValidHash } from '../src/index.js';

describe('blobsy exports', () => {
  it('exports BREF_FORMAT constant', () => {
    expect(BREF_FORMAT).toBe('blobsy-bref/0.1');
  });

  it('exports isValidHash function', () => {
    expect(isValidHash('sha256:' + 'a'.repeat(64))).toBe(true);
    expect(isValidHash('invalid')).toBe(false);
  });
});
