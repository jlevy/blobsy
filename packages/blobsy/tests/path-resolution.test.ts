import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCacheEntryPath,
  normalizePath,
  resolveRepoPath,
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

describe('resolveRepoPath (SEC-02: repo containment)', () => {
  let repoRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'blobsy-repo-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'blobsy-outside-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('accepts relative paths inside the repo', () => {
    expect(resolveRepoPath('data/file.bin', repoRoot, repoRoot)).toBe(
      join(realpathSync(repoRoot), 'data', 'file.bin'),
    );
  });

  it('accepts absolute paths inside the repo', () => {
    const inside = join(realpathSync(repoRoot), 'data', 'file.bin');
    expect(resolveRepoPath(inside, repoRoot, repoRoot)).toBe(inside);
  });

  it('rejects ../ escapes', () => {
    expect(() => resolveRepoPath('../escape.bin', repoRoot, repoRoot)).toThrow(
      /outside the repository/,
    );
  });

  it('rejects absolute paths outside the repo', () => {
    expect(() => resolveRepoPath(join(outsideDir, 'x.bin'), repoRoot, repoRoot)).toThrow(
      /outside the repository/,
    );
  });

  it('rejects a sibling directory sharing the repo-root prefix', () => {
    expect(() => resolveRepoPath(`${repoRoot}-data/x.bin`, repoRoot, repoRoot)).toThrow(
      /outside the repository/,
    );
  });

  it('rejects symlinks that point outside the repo', async () => {
    const target = join(outsideDir, 'target.bin');
    await writeFile(target, 'outside content');
    const linkPath = join(repoRoot, 'link.bin');
    await symlink(target, linkPath);

    expect(() => resolveRepoPath('link.bin', repoRoot, repoRoot)).toThrow(/outside the repository/);
  });

  it('rejects not-yet-existing paths under an escaping symlinked directory', async () => {
    const linkDir = join(repoRoot, 'linked');
    await symlink(outsideDir, linkDir);

    expect(() => resolveRepoPath('linked/new-file.bin', repoRoot, repoRoot)).toThrow(
      /outside the repository/,
    );
  });

  it('accepts not-yet-existing paths inside the repo (mv destinations)', () => {
    expect(resolveRepoPath('new/deep/dest.bin', repoRoot, repoRoot)).toBe(
      join(realpathSync(repoRoot), 'new', 'deep', 'dest.bin'),
    );
  });
});
