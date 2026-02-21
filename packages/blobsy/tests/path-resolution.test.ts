import { describe, expect, it } from 'vitest';

import {
  getCacheEntryPath,
  normalizePath,
  stripYrefExtension,
  toRepoRelative,
  yrefPath,
} from '../src/paths.js';

describe('paths', () => {
  it('strips .yref extension', () => {
    expect(stripYrefExtension('data/model.bin.yref')).toBe('data/model.bin');
  });

  it('leaves non-.yref path unchanged', () => {
    expect(stripYrefExtension('data/model.bin')).toBe('data/model.bin');
  });

  it('appends .yref extension', () => {
    expect(yrefPath('data/model.bin')).toBe('data/model.bin.yref');
  });

  it('handles .yref input for yrefPath (idempotent)', () => {
    expect(yrefPath('data/model.bin.yref')).toBe('data/model.bin.yref');
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
