/**
 * Path resolution utilities.
 *
 * Handles repo root detection, .bref suffix management, POSIX normalization,
 * and stat cache path computation.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';

import picomatch from 'picomatch';

import { ValidationError, BREF_EXTENSION } from './types.js';

/** Find the git repository root by walking up from cwd. */
export function findRepoRoot(startDir?: string): string {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: startDir ?? process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return root;
  } catch {
    throw new ValidationError('Not inside a git repository.', [
      'Run this command from within a git repo.',
    ]);
  }
}

/** Convert an absolute path to repo-relative with POSIX separators. */
export function toRepoRelative(absolutePath: string, repoRoot: string): string {
  return normalizePath(relative(repoRoot, absolutePath));
}

/** Strip .bref extension if present: "data/model.bin.bref" -> "data/model.bin" */
export function stripBrefExtension(path: string): string {
  if (path.endsWith(BREF_EXTENSION)) {
    return path.slice(0, -BREF_EXTENSION.length);
  }
  return path;
}

/** Append .bref extension: "data/model.bin" -> "data/model.bin.bref" */
export function brefPath(filePath: string): string {
  const stripped = stripBrefExtension(filePath);
  return `${stripped}${BREF_EXTENSION}`;
}

/** Normalize to POSIX forward slashes. */
export function normalizePath(path: string): string {
  const normalized = normalize(path);
  if (sep === '\\') {
    return normalized.replace(/\\/g, '/');
  }
  return normalized;
}

/**
 * Length of the hash prefix used for stat cache file naming.
 * Using 18 hex chars (72 bits) provides sufficient uniqueness while keeping paths short.
 */
const STAT_CACHE_HASH_LENGTH = 18;

/** Length of directory prefix for sharding stat cache entries (2 chars = 256 subdirs) */
const STAT_CACHE_SHARD_PREFIX_LENGTH = 2;

/**
 * Compute the stat cache entry path.
 *
 * SHA-256 of repo-relative path, first 18 hex chars, 2-char prefix sharding.
 * Example: ".blobsy/stat-cache/a1/a1b2c3d4e5f6g7h8i9.json"
 */
export function getCacheEntryPath(cacheDir: string, relativePath: string): string {
  const hash = createHash('sha256')
    .update(relativePath)
    .digest('hex')
    .substring(0, STAT_CACHE_HASH_LENGTH);
  const prefix = hash.substring(0, STAT_CACHE_SHARD_PREFIX_LENGTH);
  return join(cacheDir, prefix, `${hash}.json`);
}

/** Resolve a user-provided path to an absolute path. */
export function resolveFilePath(inputPath: string, cwd?: string): string {
  return resolve(cwd ?? process.cwd(), inputPath);
}

/** Check if a path is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find all .bref files in a directory recursively.
 * Returns repo-relative paths of the data files (with .bref stripped).
 */
export function findBrefFiles(dir: string, repoRoot: string): string[] {
  const results: string[] = [];
  walkDir(dir, dir, null, (filePath) => {
    if (filePath.endsWith(BREF_EXTENSION)) {
      results.push(toRepoRelative(stripBrefExtension(filePath), repoRoot));
    }
  });
  return results.sort();
}

/**
 * Find all non-bref, non-hidden files in a directory for tracking.
 * Returns absolute paths. Applies ignore patterns to skip directories and files.
 */
export function findTrackableFiles(dir: string, ignorePatterns?: string[]): string[] {
  const matcher = ignorePatterns?.length ? picomatch(ignorePatterns, { dot: true }) : null;
  const results: string[] = [];
  walkDir(dir, dir, matcher, (filePath) => {
    const name = basename(filePath);
    if (!name.endsWith(BREF_EXTENSION) && !name.startsWith('.')) {
      results.push(filePath);
    }
  });
  return results.sort();
}

function walkDir(
  dir: string,
  rootDir: string,
  ignoreMatcher: ((path: string) => boolean) | null,
  callback: (filePath: string) => void,
): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    const relPath = normalizePath(relative(rootDir, fullPath));
    // Check ignore patterns against relative path and name
    if (ignoreMatcher && (ignoreMatcher(relPath) || ignoreMatcher(entry.name))) {
      continue;
    }
    if (entry.isDirectory()) {
      // Also check directory with trailing slash for glob patterns like "node_modules/"
      const dirRel = relPath + '/';
      if (ignoreMatcher?.(dirRel)) {
        continue;
      }
      walkDir(fullPath, rootDir, ignoreMatcher, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

/** Get the directory component of a path. */
export function getDirectory(path: string): string {
  return dirname(path);
}

/** Get the filename component of a path. */
export function getFilename(path: string): string {
  return basename(path);
}
