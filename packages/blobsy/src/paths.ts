/**
 * Path resolution utilities.
 *
 * Handles repo root detection, .yref suffix management, POSIX normalization,
 * and stat cache path computation.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';

import { YREF_EXTENSION } from './types.js';

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
    throw new Error('Not inside a git repository. Run this command from within a git repo.');
  }
}

/** Convert an absolute path to repo-relative with POSIX separators. */
export function toRepoRelative(absolutePath: string, repoRoot: string): string {
  return normalizePath(relative(repoRoot, absolutePath));
}

/** Strip .yref extension if present: "data/model.bin.yref" -> "data/model.bin" */
export function stripYrefExtension(path: string): string {
  if (path.endsWith(YREF_EXTENSION)) {
    return path.slice(0, -YREF_EXTENSION.length);
  }
  return path;
}

/** Append .yref extension: "data/model.bin" -> "data/model.bin.yref" */
export function yrefPath(filePath: string): string {
  const stripped = stripYrefExtension(filePath);
  return `${stripped}${YREF_EXTENSION}`;
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
 * Compute the stat cache entry path.
 *
 * SHA-256 of repo-relative path, first 18 hex chars, 2-char prefix sharding.
 * Example: ".blobsy/stat-cache/a1/a1b2c3d4e5f6g7h8i9.json"
 */
export function getCacheEntryPath(cacheDir: string, relativePath: string): string {
  const hash = createHash('sha256').update(relativePath).digest('hex').substring(0, 18);
  const prefix = hash.substring(0, 2);
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
 * Find all .yref files in a directory recursively.
 * Returns repo-relative paths of the data files (with .yref stripped).
 */
export function findYrefFiles(dir: string, repoRoot: string): string[] {
  const results: string[] = [];
  walkDir(dir, (filePath) => {
    if (filePath.endsWith(YREF_EXTENSION)) {
      results.push(toRepoRelative(stripYrefExtension(filePath), repoRoot));
    }
  });
  return results.sort();
}

/**
 * Find all non-yref, non-hidden files in a directory for tracking.
 * Returns absolute paths.
 */
export function findTrackableFiles(dir: string): string[] {
  const results: string[] = [];
  walkDir(dir, (filePath) => {
    const name = basename(filePath);
    if (!name.endsWith(YREF_EXTENSION) && !name.startsWith('.')) {
      results.push(filePath);
    }
  });
  return results.sort();
}

function walkDir(dir: string, callback: (filePath: string) => void): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
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
