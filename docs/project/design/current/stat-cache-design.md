# Blobsy: Stat Cache Design

**Date:** 2026-02-21

**Status:** Draft

**Supersedes:** Stat cache sections previously in `blobsy-design-v2.md` ("Local Stat
Cache") and `conflict-detection-and-resolution.md` ("Layer 2: Detection via Stat Cache
Three-Way Merge"). Those docs now cross-reference this file.

## Overview

The stat cache is a local, machine-specific store that tracks the last-known state of
each file blobsy has interacted with.
It serves two purposes:

1. **Performance** -- Avoid re-hashing unchanged files by checking filesystem metadata
   (size + mtime) first.
2. **Correctness** -- Provide the merge base for three-way conflict detection during
   sync.

The cache is **mandatory** for operations that modify `.yref` files (`track`, `push`,
`pull`, `sync`). It is optional for read-only operations (`status`, `verify`), which
fall back to hashing all files if the cache is missing.

## Storage: One File Per Entry

Follows the same pattern as
[tbd’s issue storage](https://github.com/jlevy/tbd/blob/main/packages/tbd/src/file/storage.ts):
one file per object, atomic writes, no merge conflicts between concurrent processes.

### Why Not a Single JSON File

A single `stat-cache.json` has a concurrent-write problem: two `blobsy` processes read
the file, each update different entries, last write wins and loses the other’s updates.
File locking is fragile (not portable across NFS/network mounts, deadlock risk, stale
lock cleanup).

File-per-entry eliminates this entirely.
Two processes updating different tracked files write to different cache files -- no
coordination needed.

### Directory Layout

```
.blobsy/stat-cache/           # gitignored, machine-local
  a1/
    b2c3d4e5f6g7h8i9.json    # cache entry for one tracked file
  ff/
    0a1b2c3d4e5f6g7h.json
```

Path from tracked file to cache file:

```typescript
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function getCacheEntryPath(cacheDir: string, relativePath: string): string {
  const hash = createHash('sha256').update(relativePath).digest('hex').substring(0, 18);
  const prefix = hash.substring(0, 2);
  return join(cacheDir, prefix, `${hash}.json`);
}
```

18 hex chars = 72 bits of the SHA-256 of the relative path.
Collision-free at any practical scale (birthday bound ~2^36 entries).
The 2-char prefix directory provides git-object-style sharding (256 buckets).

### Entry Format

```typescript
interface StatCacheEntry {
  /** Relative path to the tracked file (for human readability / debugging). */
  path: string;

  /** SHA-256 content hash, e.g. "sha256:abc123...". */
  hash: string;

  /** File size in bytes. Part of the composite comparison key (size + mtime). */
  size: number;

  /** Modification time in nanoseconds (BigInt serialized as string), or null if unavailable. */
  mtimeNs: string | null;

  /** Modification time in milliseconds (float). Fallback when mtimeNs unavailable. */
  mtimeMs: number;

  /** When this entry was last written (ms since epoch). */
  cachedAt: number;
}
```

The **composite comparison key** for change detection is `size` + `mtimeNs`. Both must
match the cached entry for the cached hash to be trusted.
If nanosecond precision is unavailable (platform limitation or missing from a cache
entry), the fallback comparison key is `size` + `mtimeMs`.

`mtimeNs` is stored as a string because JSON does not support BigInt.
`mtimeMs` is also useful independently for sorting, display, and contexts where BigInt
parsing is unnecessary.

Both values come directly from `fs.stat()` -- no conversion needed:

```typescript
import { stat } from 'node:fs/promises';

const stats = await stat(filePath, { bigint: true });
// stats.mtimeNs  → BigInt (nanoseconds)
// stats.mtimeMs  → number (milliseconds float) -- from non-bigint stat

// For the bigint stat call, derive mtimeMs:
const mtimeMs = Number(stats.mtimeNs / 1_000_000n);
```

### Entry File Content

Each `.json` file contains a single `StatCacheEntry` serialized as JSON:

```json
{
  "path": "data/model.bin",
  "hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 104857600,
  "mtimeNs": "1708468523456789000",
  "mtimeMs": 1708468523456.789,
  "cachedAt": 1708468523500
}
```

## Storage Layer API

Modeled on tbd’s function-based storage layer (`readIssue`, `writeIssue`, `listIssues`,
`deleteIssue`). Stateless functions that take a cache directory path.

```typescript
import { readFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { writeFile } from 'atomically';

/**
 * Read a cache entry for a tracked file.
 * Returns null if no entry exists (never throws for missing entries).
 */
export async function readCacheEntry(
  cacheDir: string,
  relativePath: string,
): Promise<StatCacheEntry | null> {
  const entryPath = getCacheEntryPath(cacheDir, relativePath);
  try {
    const content = await readFile(entryPath, 'utf-8');
    return JSON.parse(content) as StatCacheEntry;
  } catch {
    return null;
  }
}

/**
 * Write a cache entry. Atomic via write-to-temp-then-rename.
 * Creates parent directory if needed.
 */
export async function writeCacheEntry(
  cacheDir: string,
  entry: StatCacheEntry,
): Promise<void> {
  const entryPath = getCacheEntryPath(cacheDir, entry.path);
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, JSON.stringify(entry, null, 2) + '\n');
}

/**
 * Delete a cache entry. No-op if entry doesn't exist.
 */
export async function deleteCacheEntry(
  cacheDir: string,
  relativePath: string,
): Promise<void> {
  const entryPath = getCacheEntryPath(cacheDir, relativePath);
  try {
    await unlink(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * List all cache entries. Parallel reads for performance.
 * Tolerant of corrupt/invalid entries (skips with warning).
 */
export async function listCacheEntries(
  cacheDir: string,
): Promise<StatCacheEntry[]> {
  // Read all prefix directories, then all .json files within
  let prefixDirs: string[];
  try {
    prefixDirs = await readdir(cacheDir);
  } catch {
    return [];
  }

  const entries: StatCacheEntry[] = [];
  const readPromises: Promise<void>[] = [];

  for (const prefix of prefixDirs) {
    readPromises.push(
      (async () => {
        const prefixPath = join(cacheDir, prefix);
        let files: string[];
        try {
          files = await readdir(prefixPath);
        } catch {
          return;
        }
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        const fileReads = jsonFiles.map(async (file) => {
          try {
            const content = await readFile(join(prefixPath, file), 'utf-8');
            entries.push(JSON.parse(content) as StatCacheEntry);
          } catch {
            // Skip corrupt entries
          }
        });
        await Promise.all(fileReads);
      })(),
    );
  }

  await Promise.all(readPromises);
  return entries;
}
```

The `atomically` package (used by tbd for issue writes) handles the
write-to-temp-then-rename pattern.
This ensures a crash mid-write never produces a corrupt entry file -- the old entry
remains until the new one is fully written.

## Dual Role

### Role 1: Performance Optimization

On `push`, `sync`, or `verify`, blobsy calls `stat()` on each local file.
If `size` and `mtimeNs` match the cached entry, the cached `hash` is trusted -- no read
or hash needed.

```
stat() → compare size + mtimeNs → match? → use cached hash (skip I/O)
                                → differ? → read + hash file → update cache
```

`stat()` costs ~1-5 microseconds per file.
For 1,000 tracked files, the stat pass takes ~5 ms vs.
seconds-to-minutes to hash all files.

| Scenario (1000 files, 10 MB avg) | Without cache | With cache |
| --- | --- | --- |
| First push | Hash all: ~20s | Hash all: ~20s (same) |
| Second push, 3 files changed | Hash all: ~20s | Stat all + hash 3: ~65ms |
| After `git checkout` (mtime reset) | Hash all: ~20s | Stat all + hash all: ~20s |

**Why mtime is safe locally but not in refs:** The stat cache is per-machine.
It compares a file’s current mtime against the mtime recorded *on the same machine*
after the last hash.
The `.yref` file cannot use mtime because different machines, git checkouts, CI runners,
and Docker builds produce different mtimes for identical content.

### Role 2: Merge Base for Conflict Detection

The cached `hash` is the merge base for three-way conflict detection.
For each tracked file, blobsy has three hash states:

- **Local**: hash of the file on disk
- **Remote**: hash in the `.yref` file (from git)
- **Base**: hash in stat cache (last time blobsy touched this file)

This is what distinguishes “git pull updated the .yref” from “user modified the file” --
without the merge base, the two cases are indistinguishable.

**The `getCachedHash` vs `getMergeBase` distinction:**

```typescript
/**
 * Fast-path hash lookup. Returns cached hash only if current stat matches
 * (file unchanged since last cache write). Returns null if stat differs.
 *
 * Comparison key: size + mtimeNs. Falls back to size + mtimeMs when
 * nanosecond precision is unavailable.
 */
async function getCachedHash(
  cacheDir: string,
  relativePath: string,
  currentStats: { size: number; mtimeNs: bigint | null; mtimeMs: number },
): Promise<string | null> {
  const entry = await readCacheEntry(cacheDir, relativePath);
  if (!entry) return null;
  if (entry.size !== currentStats.size) return null;

  if (currentStats.mtimeNs !== null && entry.mtimeNs) {
    if (entry.mtimeNs !== currentStats.mtimeNs.toString()) return null;
  } else {
    if (entry.mtimeMs !== currentStats.mtimeMs) return null;
  }

  return entry.hash;
}

/**
 * Merge base lookup. Returns the cached hash regardless of current stat.
 * This is the "last known state" for three-way conflict detection.
 */
async function getMergeBase(
  cacheDir: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await readCacheEntry(cacheDir, relativePath);
  return entry?.hash ?? null;
}
```

## Three-Way Merge Algorithm

Used by `blobsy sync` to determine the correct action for each tracked file.

### Decision Table

| Local | .yref | Base (cache) | Interpretation | Action |
| --- | --- | --- | --- | --- |
| A | A | A | No changes | Nothing |
| A | A | (none) | First sync, already matching | Create cache entry |
| A | B | A | .yref updated by git pull, local unchanged | Pull new blob |
| B | A | A | User modified file, .yref unchanged | Push new version |
| B | B | A | User modified + already synced | Nothing |
| B | C | A | Both local and .yref changed | **Conflict** (error) |
| B | A | (none) | Ambiguous -- no merge base | **Error** (ask user) |

### Sync Per-File Logic

```typescript
async function syncFile(
  cacheDir: string,
  filePath: string,
): Promise<SyncAction> {
  const localHash = await computeHash(filePath);
  const ref = await readYRef(filePath + '.yref');
  const baseHash = await getMergeBase(cacheDir, filePath);

  // Everything matches
  if (localHash === ref.hash) {
    if (!baseHash || baseHash === localHash) {
      await updateCacheEntry(cacheDir, filePath, localHash);
      return { action: 'up_to_date' };
    }
  }

  // No merge base -- ambiguous
  if (!baseHash) {
    if (localHash === ref.hash) {
      await updateCacheEntry(cacheDir, filePath, localHash);
      return { action: 'up_to_date', note: 'first sync' };
    }
    return {
      action: 'error',
      reason: 'ambiguous',
      message:
        `No stat cache entry for ${filePath}. ` +
        `Cannot distinguish local edit from git pull. ` +
        `Use 'blobsy push' or 'blobsy pull' explicitly.`,
    };
  }

  // .yref changed, local unchanged → pull
  if (localHash === baseHash && ref.hash !== baseHash) {
    return { action: 'pull', remoteKey: ref.remote_key };
  }

  // Local changed, .yref unchanged → push
  if (localHash !== baseHash && ref.hash === baseHash) {
    return { action: 'push', newHash: localHash };
  }

  // Both changed → conflict
  if (localHash !== baseHash && ref.hash !== baseHash && localHash !== ref.hash) {
    return {
      action: 'conflict',
      localHash,
      remoteHash: ref.hash,
      baseHash,
    };
  }

  // Local changed to match .yref (coincidental or already synced)
  await updateCacheEntry(cacheDir, filePath, localHash);
  return { action: 'up_to_date' };
}
```

## Cache Update Rules

The cache MUST be updated atomically with the operation that changes file state:

| Operation | When to update cache |
| --- | --- |
| `blobsy track` | After writing `.yref`, update cache with new hash |
| `blobsy push` | After successful upload + `.yref` update |
| `blobsy pull` | After successful download (file on disk matches `.yref`) |
| `blobsy sync` | After each file’s action completes (push, pull, or no-op) |

**Never** update the cache without completing the corresponding operation.
If a push fails mid-upload, the cache must retain the old entry (or no entry) so the
next sync retries correctly.

```typescript
async function updateCacheEntry(
  cacheDir: string,
  relativePath: string,
  hash: string,
): Promise<void> {
  const stats = await stat(relativePath, { bigint: true });
  await writeCacheEntry(cacheDir, {
    path: relativePath,
    hash,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    mtimeMs: Number(stats.mtimeNs / 1_000_000n),
    cachedAt: Date.now(),
  });
}
```

## Cache Invalidation

The stat cache uses **size + mtime** as the composite invalidation signal:

1. Compare `size` -- if different, file changed, re-hash.
2. Compare `mtimeNs` (nanosecond precision) -- if different, file may have changed,
   re-hash. If nanosecond values are unavailable on either side, fall back to comparing
   `mtimeMs` (millisecond precision).
3. If both match -- trust cached hash (skip I/O).

This is the same approach git’s index uses.
It is a “definitely changed” signal -- if mtime changed, something touched the file.
The false-positive rate (mtime changed but content identical) is harmless (just triggers
an unnecessary re-hash).

The false-negative case (content changed but mtime unchanged) requires sub-millisecond
(or sub-nanosecond when available) modification, which is not realistic in practice.

## Missing Cache / Recovery

| Scenario | Behavior |
| --- | --- |
| Fresh clone (no cache) | All entries missing. If local matches .yref → create entries. If mismatch → error, ask user. |
| Cache deleted | Same as fresh clone. |
| Single entry missing | That file treated as first-sync (ambiguous if mismatched). |
| Corrupt entry file | Skipped on read (returns null). Overwritten on next write. |

### Rebuild Command

`blobsy verify --rebuild-cache` rebuilds the cache by hashing all tracked files:

```
For each .yref file:
  1. Hash the local file
  2. If hash matches .yref → create cache entry (file is in sync)
  3. If hash differs → skip (don't create entry -- ambiguous state)
  4. If local file missing → skip
```

This is only valid when the user confirms files are in the expected state.
It is a recovery tool, not a normal operation.

## Garbage Collection

Over time, cache entries accumulate for files that are no longer tracked.
The `gc` operation removes orphaned entries:

```typescript
async function gcCache(
  cacheDir: string,
  trackedFiles: Set<string>,
): Promise<number> {
  const entries = await listCacheEntries(cacheDir);
  let removed = 0;
  for (const entry of entries) {
    if (!trackedFiles.has(entry.path)) {
      await deleteCacheEntry(cacheDir, entry.path);
      removed++;
    }
  }
  return removed;
}
```

Triggered by `blobsy doctor` or periodically during sync if entry count exceeds tracked
file count by a significant margin.

## Mandatory vs. Optional

| Operation | Cache role | If cache missing |
| --- | --- | --- |
| `track` | Write-only | Creates entry (no read needed) |
| `push` | Write after upload | Creates/updates entry |
| `pull` | Write after download | Creates/updates entry |
| `sync` | Read + write (three-way merge) | Auto-rebuild where unambiguous; error where ambiguous |
| `status` | Read (performance) | Falls back to hashing all files (slow but correct) |
| `verify` | Read (performance) | Falls back to hashing all files (slow but correct) |

## Design Provenance

The file-per-entry storage pattern is borrowed from
[tbd](https://github.com/jlevy/tbd)’s issue storage layer, which uses the same approach:
one file per object, atomic writes via the `atomically` npm package, parallel reads for
bulk operations, and tolerant parsing that skips corrupt entries.
The key advantage is eliminating merge/coordination problems -- concurrent processes
writing different entries never conflict.

Differences from tbd’s issue storage:

| Aspect | tbd issues | blobsy stat cache |
| --- | --- | --- |
| Format | Markdown + YAML frontmatter | JSON |
| Key | Issue ID (human-readable) | SHA-256 prefix of file path |
| Directory structure | Flat (`issues/{id}.md`) | Sharded (`{prefix}/{hash}.json`) |
| Shared via git | Yes (committed to repo) | No (gitignored, machine-local) |
| Concurrent access | Rare (single user) | Common (parallel blobsy processes) |
