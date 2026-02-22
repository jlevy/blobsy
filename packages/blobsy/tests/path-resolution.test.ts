import { describe, expect, it } from 'vitest';

import {
  getCacheEntryPath,
  normalizePath,
  stripBrefExtension,
  toRepoRelative,
  brefPath,
} from '../src/paths.js';

describe('paths', () => {
  it('strips .bref extension', () => {
    expect(stripBrefExtension('data/model.bin.bref')).toBe('data/model.bin');
  });

  it('leaves non-.bref path unchanged', () => {
    expect(stripBrefExtension('data/model.bin')).toBe('data/model.bin');
  });

  it('appends .bref extension', () => {
    expect(brefPath('data/model.bin')).toBe('data/model.bin.bref');
  });

  it('handles .bref input for brefPath (idempotent)', () => {
    expect(brefPath('data/model.bin.bref')).toBe('data/model.bin.bref');
  });

  it('converts absolute to repo-relative', () => {
    expect(toRepoRelative('/repo/data/file.bin', '/repo')).toBe('data/file.bin');
  });

  it('normalizes paths to forward slashes', () => {
    expect(normalizePath('data/research/file.bin')).toBe('data/research/file.bin');
  });

  it('computes cache entry path with prefix sharding', () => {
    const path = getCacheEntryPath('/cache', 'data/model.bin');
    expect(path).toMatch(/^\/cache\/[0-9a-f]{2}\/[0-9a-f]{18}\.json$/);
  });

  it('cache entry path is deterministic', () => {
    const p1 = getCacheEntryPath('/cache', 'data/model.bin');
    const p2 = getCacheEntryPath('/cache', 'data/model.bin');
    expect(p1).toBe(p2);
  });

  it('different paths produce different cache entries', () => {
    const p1 = getCacheEntryPath('/cache', 'data/a.bin');
    const p2 = getCacheEntryPath('/cache', 'data/b.bin');
    expect(p1).not.toBe(p2);
  });
});
