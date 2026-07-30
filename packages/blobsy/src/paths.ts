/**
 * Path resolution utilities.
 *
 * Handles repo root detection, .bref suffix management, POSIX normalization,
 * and stat cache path computation.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
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

/**
 * Resolve a user-supplied path and refuse anything outside the repository.
 *
 * "The caller supplied the path" is not a safety boundary for an
 * agent-driven CLI (review finding SEC-02): without containment,
 * `rm`/`untrack`/`mv` mutate or delete files outside the repo and
 * `track`/`add` scatter `.bref`/`.gitignore` files across the filesystem.
 * Symlinks are resolved (via the deepest existing ancestor for
 * not-yet-created paths) so a link inside the repo cannot smuggle an
 * operation outside it.
 */
export function resolveRepoPath(inputPath: string, repoRoot: string, cwd?: string): string {
  const resolved = resolve(cwd ?? process.cwd(), inputPath);
  const root = realpathSync(resolve(repoRoot));
  const effective = realpathDeep(resolved);

  if (effective !== root && !effective.startsWith(root + sep)) {
    throw new ValidationError(`Path is outside the repository: ${inputPath}`, [
      `blobsy operations are confined to the repo root: ${repoRoot}`,
    ]);
  }
  return resolved;
}

/**
 * Resolve symlinks in a path that may not fully exist: realpath the path
 * itself, or — for not-yet-created paths (a mv destination, an unwritten
 * remote key) — realpath the deepest existing ancestor and append the
 * remaining lexical tail. Non-existent trailing components cannot be
 * symlinks, so the result is the real filesystem location the path denotes.
 */
export function realpathDeep(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    let dir = dirname(path);
    const tail: string[] = [basename(path)];
    while (!existsSync(dir) && dir !== dirname(dir)) {
      tail.unshift(basename(dir));
      dir = dirname(dir);
    }
    return existsSync(dir) ? join(realpathSync(dir), ...tail) : path;
  }
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
 * Optional onSymlink callback is invoked with the path of each skipped symlink.
 *
 * Dotfiles (and dot-directories) are skipped by design (review finding
 * L-10): hidden files are overwhelmingly config/state (.git, .env, .DS_Store)
 * that must not be externalized to a blob store. Track one explicitly by
 * naming it: `blobsy track .hidden.bin`.
 */
export function findTrackableFiles(
  dir: string,
  ignorePatterns?: string[],
  onSymlink?: (path: string) => void,
): string[] {
  const matcher = ignorePatterns?.length ? picomatch(ignorePatterns, { dot: true }) : null;
  const results: string[] = [];
  walkDir(
    dir,
    dir,
    matcher,
    (filePath) => {
      const name = basename(filePath);
      if (!name.endsWith(BREF_EXTENSION) && !name.startsWith('.')) {
        results.push(filePath);
      }
    },
    onSymlink,
  );
  return results.sort();
}

function walkDir(
  dir: string,
  rootDir: string,
  ignoreMatcher: ((path: string) => boolean) | null,
  callback: (filePath: string) => void,
  onSymlink?: (path: string) => void,
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
      walkDir(fullPath, rootDir, ignoreMatcher, callback, onSymlink);
    } else if (entry.isFile()) {
      callback(fullPath);
    } else if (entry.isSymbolicLink()) {
      onSymlink?.(fullPath);
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
