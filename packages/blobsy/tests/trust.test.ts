import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trustRepo, revokeRepo, isRepoTrusted, listTrustedRepos } from '../src/trust.js';

describe('trust', () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'blobsy-trust-test-'));
    vi.stubEnv('HOME', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('repo is not trusted by default', () => {
    expect(isRepoTrusted('/some/repo')).toBe(false);
  });

  it('trust and check', () => {
    trustRepo('/some/repo');
    expect(isRepoTrusted('/some/repo')).toBe(true);
    expect(isRepoTrusted('/other/repo')).toBe(false);
  });

  it('revoke returns true when trusted', () => {
    trustRepo('/some/repo');
    expect(revokeRepo('/some/repo')).toBe(true);
    expect(isRepoTrusted('/some/repo')).toBe(false);
  });

  it('revoke returns false when not trusted', () => {
    expect(revokeRepo('/some/repo')).toBe(false);
  });

  it('list returns all trusted repos', () => {
    trustRepo('/repo/a');
    trustRepo('/repo/b');
    const list = listTrustedRepos();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.path).sort()).toEqual(['/repo/a', '/repo/b']);
    expect(list[0]!.trustedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('list returns empty array when no trusted repos', () => {
    expect(listTrustedRepos()).toEqual([]);
  });

  it('trust is idempotent', () => {
    trustRepo('/some/repo');
    trustRepo('/some/repo');
    expect(listTrustedRepos()).toHaveLength(1);
  });
});
