/**
 * Stat cache tests (review finding TEST-04).
 *
 * The stat cache supplies the merge base for three-way sync (DS-01), so its
 * behavior under stale stats, corrupt entries, and concurrent writes must be
 * pinned down before sync relies on it. Cases follow
 * blobsy-testing-design.md ("Stat Cache"); the listCacheEntries / mtimeMs
 * fallback / GC cases await those functions being implemented.
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCacheEntry,
  deleteCacheEntry,
  getCachedHash,
  getMergeBase,
  getStatCacheDir,
  readCacheEntry,
  writeCacheEntry,
} from '../src/stat-cache.js';
import { getCacheEntryPath } from '../src/paths.js';
import type { StatCacheEntry } from '../src/types.js';

const TEST_HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_HASH = `sha256:${'b'.repeat(64)}`;

let testDir: string;
let cacheDir: string;

async function makeEntry(relativePath: string, filePath: string): Promise<StatCacheEntry> {
  return createCacheEntry(filePath, relativePath, TEST_HASH);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'blobsy-stat-cache-'));
  cacheDir = join(testDir, '.blobsy', 'stat-cache');
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('readCacheEntry', () => {
  it('returns null for a missing entry', async () => {
    expect(await readCacheEntry(cacheDir, 'data/missing.bin')).toBeNull();
  });

  it('returns null for corrupt JSON instead of throwing', async () => {
    const entryPath = getCacheEntryPath(cacheDir, 'data/corrupt.bin');
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, '{ not json');
    expect(await readCacheEntry(cacheDir, 'data/corrupt.bin')).toBeNull();
  });

  it('round-trips an entry written by writeCacheEntry', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    const entry = await makeEntry('data/file.bin', filePath);
    await writeCacheEntry(cacheDir, entry);
    expect(await readCacheEntry(cacheDir, 'data/file.bin')).toEqual(entry);
  });
});

describe('writeCacheEntry', () => {
  it('creates the entry file at the hashed path, creating prefix dirs', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    const entry = await makeEntry('deep/nested/file.bin', filePath);
    await writeCacheEntry(cacheDir, entry);

    const entryPath = getCacheEntryPath(cacheDir, 'deep/nested/file.bin');
    expect(existsSync(entryPath)).toBe(true);
    const parsed = JSON.parse(await readFile(entryPath, 'utf-8')) as StatCacheEntry;
    expect(parsed.path).toBe('deep/nested/file.bin');
    expect(parsed.hash).toBe(TEST_HASH);
  });

  it('concurrent writes to different entries all land intact', async () => {
    const files = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const filePath = join(testDir, `file-${i}.bin`);
        await writeFile(filePath, `content-${i}`);
        return { filePath, rel: `data/file-${i}.bin` };
      }),
    );
    await Promise.all(
      files.map(async ({ filePath, rel }) => {
        const entry = await makeEntry(rel, filePath);
        await writeCacheEntry(cacheDir, entry);
      }),
    );
    for (const { rel } of files) {
      const entry = await readCacheEntry(cacheDir, rel);
      expect(entry?.path).toBe(rel);
    }
  });
});

describe('deleteCacheEntry', () => {
  it('removes an existing entry and is a no-op when missing', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    const entry = await makeEntry('data/file.bin', filePath);
    await writeCacheEntry(cacheDir, entry);

    await deleteCacheEntry(cacheDir, 'data/file.bin');
    expect(await readCacheEntry(cacheDir, 'data/file.bin')).toBeNull();

    await expect(deleteCacheEntry(cacheDir, 'data/file.bin')).resolves.toBeUndefined();
  });
});

describe('getCachedHash', () => {
  it('returns the hash when size and mtimeNs match', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    await writeCacheEntry(cacheDir, await makeEntry('data/file.bin', filePath));

    expect(await getCachedHash(cacheDir, 'data/file.bin', filePath)).toBe(TEST_HASH);
  });

  it('returns null when size differs', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    await writeCacheEntry(cacheDir, await makeEntry('data/file.bin', filePath));

    await writeFile(filePath, 'content-grown');
    expect(await getCachedHash(cacheDir, 'data/file.bin', filePath)).toBeNull();
  });

  it('returns null when mtime differs at same size', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    await writeCacheEntry(cacheDir, await makeEntry('data/file.bin', filePath));

    const past = new Date(Date.now() - 60_000);
    await utimes(filePath, past, past);
    expect(await getCachedHash(cacheDir, 'data/file.bin', filePath)).toBeNull();
  });

  it('returns null when the file is missing', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    await writeCacheEntry(cacheDir, await makeEntry('data/file.bin', filePath));

    await rm(filePath);
    expect(await getCachedHash(cacheDir, 'data/file.bin', filePath)).toBeNull();
  });

  it('returns null with no cache entry', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    expect(await getCachedHash(cacheDir, 'data/file.bin', filePath)).toBeNull();
  });
});

describe('getMergeBase', () => {
  it('returns the cached hash even when the file has since changed', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    await writeCacheEntry(cacheDir, await makeEntry('data/file.bin', filePath));

    await writeFile(filePath, 'completely different content');
    expect(await getMergeBase(cacheDir, 'data/file.bin')).toBe(TEST_HASH);
  });

  it('returns null with no entry', async () => {
    expect(await getMergeBase(cacheDir, 'data/nope.bin')).toBeNull();
  });

  it('reflects the most recent write (base moves forward after sync)', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'content');
    await writeCacheEntry(cacheDir, await makeEntry('data/file.bin', filePath));

    const updated = { ...(await makeEntry('data/file.bin', filePath)), hash: OTHER_HASH };
    await writeCacheEntry(cacheDir, updated);
    expect(await getMergeBase(cacheDir, 'data/file.bin')).toBe(OTHER_HASH);
  });
});

describe('getCacheEntryPath', () => {
  it('is deterministic for the same relative path', () => {
    expect(getCacheEntryPath(cacheDir, 'data/file.bin')).toBe(
      getCacheEntryPath(cacheDir, 'data/file.bin'),
    );
  });

  it('differs for different relative paths', () => {
    expect(getCacheEntryPath(cacheDir, 'data/a.bin')).not.toBe(
      getCacheEntryPath(cacheDir, 'data/b.bin'),
    );
  });

  it('uses a 2-char shard prefix directory under the cache dir', () => {
    const entryPath = getCacheEntryPath(cacheDir, 'data/file.bin');
    const prefix = basename(dirname(entryPath));
    expect(prefix).toHaveLength(2);
    expect(entryPath.startsWith(cacheDir + sep)).toBe(true);
    expect(basename(entryPath)).toMatch(/^[0-9a-f]+\.json$/);
    expect(basename(entryPath).startsWith(prefix)).toBe(true);
  });
});

describe('createCacheEntry', () => {
  it('captures current size, mtimeNs, and the provided hash', async () => {
    const filePath = join(testDir, 'file.bin');
    await writeFile(filePath, 'twelve bytes');
    const entry = await createCacheEntry(filePath, 'data/file.bin', TEST_HASH);
    const stats = await stat(filePath, { bigint: true });

    expect(entry.path).toBe('data/file.bin');
    expect(entry.hash).toBe(TEST_HASH);
    expect(entry.size).toBe(Number(stats.size));
    expect(entry.mtimeNs).toBe(stats.mtimeNs.toString());
  });
});

describe('getStatCacheDir', () => {
  it('is .blobsy/stat-cache under the repo root', () => {
    expect(getStatCacheDir(testDir)).toBe(join(testDir, '.blobsy', 'stat-cache'));
  });
});
