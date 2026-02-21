/**
 * Per-file stat cache.
 *
 * File-per-entry cache at .blobsy/stat-cache/ (gitignored, machine-local).
 * Provides fast change detection and merge base for three-way sync.
 */

import { existsSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeFile } from 'atomically';

import type { StatCacheEntry } from './types.js';
import { ensureDir } from './fs-utils.js';
import { getCacheEntryPath } from './paths.js';

const STAT_CACHE_DIR = '.blobsy/stat-cache';

/** Get the stat cache directory path for a repo. */
export function getStatCacheDir(repoRoot: string): string {
  return join(repoRoot, STAT_CACHE_DIR);
}

/** Read a stat cache entry for a given repo-relative path. */
export async function readCacheEntry(
  cacheDir: string,
  relativePath: string,
): Promise<StatCacheEntry | null> {
  const entryPath = getCacheEntryPath(cacheDir, relativePath);
  if (!existsSync(entryPath)) {
    return null;
  }

  try {
    const content = await readFile(entryPath, 'utf-8');
    return JSON.parse(content) as StatCacheEntry;
  } catch {
    // Tolerant of corrupt entries
    return null;
  }
}

/** Write a stat cache entry atomically. */
export async function writeCacheEntry(
  cacheDir: string,
  entry: StatCacheEntry,
): Promise<void> {
  const entryPath = getCacheEntryPath(cacheDir, entry.path);
  await ensureDir(dirname(entryPath));
  await writeFile(entryPath, JSON.stringify(entry, null, 2) + '\n');
}

/** Delete a stat cache entry. */
export async function deleteCacheEntry(
  cacheDir: string,
  relativePath: string,
): Promise<void> {
  const entryPath = getCacheEntryPath(cacheDir, relativePath);
  try {
    await unlink(entryPath);
  } catch {
    // Ignore if not found
  }
}

/**
 * Get the cached hash if the file hasn't changed (size + mtime match).
 * Returns null if no cache entry or stats don't match (must re-hash).
 */
export async function getCachedHash(
  cacheDir: string,
  relativePath: string,
  filePath: string,
): Promise<string | null> {
  const entry = await readCacheEntry(cacheDir, relativePath);
  if (!entry) {
    return null;
  }

  try {
    const stats = await stat(filePath, { bigint: true });
    const currentSize = Number(stats.size);
    const currentMtimeNs = stats.mtimeNs.toString();

    if (entry.size === currentSize && entry.mtimeNs === currentMtimeNs) {
      return entry.hash;
    }
  } catch {
    // File gone or inaccessible
  }

  return null;
}

/** Get the merge base hash from cache (for three-way sync). */
export async function getMergeBase(
  cacheDir: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await readCacheEntry(cacheDir, relativePath);
  return entry?.hash ?? null;
}

/** Create a stat cache entry from a file's current state. */
export async function createCacheEntry(
  filePath: string,
  relativePath: string,
  hash: string,
): Promise<StatCacheEntry> {
  const stats = await stat(filePath, { bigint: true });
  return {
    path: relativePath,
    hash,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    mtimeMs: Number(stats.mtimeMs),
    cachedAt: Date.now(),
  };
}
