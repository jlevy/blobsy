# blobsy: Git-Manifest Alternative Design

**Status:** Draft

**Date:** 2026-02-20

**Supplements:** [blobsy-design.md](blobsy-design.md)

This document describes an alternative approach to manifest storage and remote layout
that simplifies the architecture by making the `.blobsy` pointer file the manifest and
the remote a dumb blob store.
It is a supplemental design — backend system, configuration hierarchy, ignore patterns,
transfer delegation, and other fundamentals from the main design doc are unchanged.

## Motivation

The main design stores manifests remotely as separate JSON files.
This creates several coordination problems:

- **Remote manifest is a shared mutable resource.**
  Two writers can conflict on it.
  Conflict detection requires fetching the remote manifest and comparing ETags or
  timestamps.
- **Post-merge prefix gap.**
  After merging a feature branch, the pointer is on main but the data is in
  `branches/feature-x/`.
  Someone must manually push to `branches/main/`.
- **`blobsy status` requires network.**
  You can't know what's in the remote without fetching the manifest.
- **Remote layout is mutable.**
  Each push overwrites the previous state at the same path.
  No history without S3 bucket versioning.

The git-manifest approach eliminates these by moving the manifest into the `.blobsy`
pointer file itself and making each push write to a unique, immutable remote prefix.

## Core Idea

The `.blobsy` pointer file **is** the manifest.
It lists every tracked file with its hash and size, inline.
Git versions it.

The remote is a dumb blob store.
Each `blobsy push` writes to a unique prefix derived from the git commit.
Pushes never overwrite previous data.
The remote has no manifest files, no mutable state, no coordination surface.

All conflict resolution happens in git, via normal merge of the `.blobsy` file.

## Pointer File Format

### Single File

Unchanged from the main design:

```yaml
# blobsy — https://github.com/jlevy/blobsy

format: blobsy/0.1
type: file
sha256: 7a3f0e...
size: 15728640
updated: 2026-02-18T12:00:00Z
```

### Directory (Inline Manifest)

The pointer file contains the full file list:

```yaml
# blobsy — https://github.com/jlevy/blobsy

format: blobsy/0.1
type: directory
updated: 2026-02-20T14:00:00Z
total_size: 1052672
files:
  - path: raw/response.json
    sha256: b4c8d2...
    size: 1048576
  - path: report.md
    sha256: 7a3f0e...
    size: 4096
```

The `files` list is sorted lexicographically by `path` for stable diffs.

**Tradeoffs vs. remote manifest:**

| | Inline manifest | Remote manifest |
| --- | --- | --- |
| Versioned by git | Yes (free) | No (remote-only) |
| Works offline | Yes | No |
| Git diff shows file changes | Yes (meaningful) | No (only timestamp) |
| Git merge conflicts | Yes (on `files:` entries) | No (but remote conflicts instead) |
| Repo size impact | ~100 bytes per tracked file | None |
| Network to check status | None | Must fetch manifest |

**Scaling:**
At 1,000 files, the `.blobsy` file is ~100 KB.
Git handles this fine — diffs are line-based and meaningful.
At 100K+ files, diffs get noisy.
A future extension could support external manifest references for extreme scale, but
this covers the vast majority of use cases.

## Remote Storage Layout

### Prefix Template

Each push writes to a prefix based on the current git commit.
The default template is `{timestamp}-{git_hash_short}/`, producing compact ISO 8601
timestamps with a short git hash suffix:

```
20260220T140322Z-a3f2b1c/
20260220T151745Z-7d4e9f2/
20260221T093011Z-b8d1a4e/
```

Properties:

- **Sortable.** Lexicographic order = chronological order.
- **Human-readable.** Immediately obvious when each push happened.
- **Unique.** Each git commit gets its own prefix. No collisions, no overwrites.
- **Survives rebases.** The timestamp provides stable ordering even if git hashes
  change. The old hash is still useful as a forensic breadcrumb (correlate with
  reflog, debug issues).

### Configurable Prefix Templates

The prefix template is configurable.
The default covers most use cases, but teams can choose alternatives:

```yaml
# .blobsy/config.yml
namespace:
  prefix_template: "{timestamp}-{git_hash_short}"  # default
```

| Template | Example | Properties |
| --- | --- | --- |
| `{timestamp}-{git_hash_short}` | `20260220T140322Z-a3f2b1c/` | Default. Sortable, readable, unique, forensic hash. |
| `{file_hash}` | `b4c8d2e1f3a5.../` | Content-addressable. Automatic dedup across commits and branches. Opaque to browse. |
| `{timestamp}` | `20260220T140322Z/` | Sortable, no git dependency. Risk: timestamp collision if two commits at same second. |
| `{git_hash}` | `a3f2b1c4d8e9.../` | Unique, but not sortable or readable. |

**Template variables (V1):**

| Variable | Resolves to | Notes |
| --- | --- | --- |
| `{timestamp}` | Compact ISO 8601 UTC (`YYYYMMDDTHHMMSSz`) | Time of push |
| `{git_hash_short}` | First 7 characters of HEAD commit SHA | Short but sufficient for uniqueness with timestamp |
| `{git_hash}` | Full 40-character HEAD commit SHA | For content-addressable layouts |
| `{file_hash}` | SHA-256 of the individual file being uploaded | Per-file content addressing, automatic dedup |
| `{branch}` | Current git branch name | For branch-grouped layouts |

### Example Remote Layout

With default prefix template:

```
s3://bucket/project/
  20260220T140322Z-a3f2b1c/
    data/prices.parquet
    data/research-batch/
      report.md
      raw/response.json
  20260220T151745Z-7d4e9f2/
    data/research-batch/
      report.md              # updated file
      raw/response.json      # unchanged, re-uploaded
  ...
```

With `{file_hash}` prefix (content-addressable):

```
s3://bucket/project/
  b4c8d2e1f3a5.../data/research-batch/raw/response.json
  7a3f0e9b2c1d.../data/research-batch/report.md
  a1b2c3d4e5f6.../data/prices.parquet
  ...
```

Content-addressable layout deduplicates automatically: if a file hasn't changed between
commits, its hash is the same, so it maps to the same remote key.
Unchanged files are never re-uploaded.

## Commands

### `blobsy commit`

Snapshots current local file state into the `.blobsy` manifest.

```bash
$ blobsy commit data/research-batch/
Scanning data/research-batch/...
  1 new, 1 modified, 0 deleted
Updated data/research-batch.blobsy
```

What it does:

1. Scan local files in the tracked directory (applying ignore patterns).
2. Hash each file (using stat cache for unchanged files).
3. Update the `files:` list in the `.blobsy` pointer.
4. Update the `updated` timestamp.

This is a **local-only** operation.
It only modifies the `.blobsy` file on disk.
The user then `git add`s and `git commit`s it as normal.

### `blobsy push`

Uploads blobs to the remote.

```bash
$ blobsy push
Pushing to 20260220T151745Z-7d4e9f2/ ...
  data/prices.parquet (15.0 MB)
  data/research-batch/report.md (4 KB)
  data/research-batch/raw/response.json (1.0 MB)
Done. 3 files pushed.
```

**Precondition: `.blobsy` must be git committed.**
If `.blobsy` has uncommitted changes, push errors:

```
Error: data/research-batch.blobsy has uncommitted changes.
Run 'blobsy commit' then 'git add && git commit' first.
```

This constraint ensures:

- Every push maps to a real git commit (unique prefix).
- Two people can never collide (different commits = different prefixes).
- The remote is append-only (no overwrites).
- GC can check reachability of the git commit to decide what's garbage.

What it does:

1. Verify `.blobsy` is committed in git HEAD.
2. Resolve prefix template (e.g., `20260220T151745Z-a3f2b1c/`).
3. For each file in the manifest: check if the remote already has it at the resolved
   path (for content-addressable templates, this provides dedup).
4. Upload missing files.
5. Record the resolved prefix in local state (for `blobsy pull` to know where to find
   blobs).

### `blobsy pull`

Downloads blobs listed in the current `.blobsy` manifest.

```bash
$ blobsy pull
Pulling from 20260220T151745Z-7d4e9f2/ ...
  data/research-batch/report.md (4 KB)
  data/research-batch/raw/response.json (1.0 MB)
Done. 2 files pulled. 1 already up-to-date.
```

What it does:

1. Read the `.blobsy` manifest.
2. Determine which remote prefix contains the blobs (from the push metadata
   or by resolving the prefix for the current commit).
3. For each file in the manifest: compare local hash to manifest hash.
4. Download files that are missing or differ.

**Prefix resolution on pull:** After `git pull`, the local `.blobsy` file reflects
whatever the upstream committed.
The blobs were pushed by whoever made that commit, under their commit's prefix.
The `.blobsy` file (or a local mapping) must record which prefix the blobs live under
so pull knows where to find them.

Options for storing the remote prefix mapping:

1. **Store in the `.blobsy` file itself** as a `remote_prefix` field.
   Simple, git-versioned, but couples the pointer to a specific push.
2. **Local-only mapping** (`.blobsy/cache/prefix-map.json`) populated on push and
   propagated via a convention (e.g., a small remote index file).
3. **Derive from git metadata** — walk git log to find the commit that last modified the
   `.blobsy` file, reconstruct the prefix from that commit's hash and timestamp.

Option 3 is the most elegant (no extra state) but requires git history access.
Option 1 is simplest and most explicit.
This is a design decision to resolve before implementation.

### `blobsy status`

Compares local files against the `.blobsy` manifest. **Fully offline.**

```bash
$ blobsy status
data/research-batch.blobsy:
  report.md           modified  (local ≠ manifest)
  raw/response.json   ok
  new-file.csv        untracked
data/prices.parquet.blobsy:
  ok
```

What it does:

1. For each `.blobsy` pointer, compare local files against the manifest's `files:` list.
2. Report: ok, modified, deleted, untracked.

No network access needed.
The manifest is right there in the `.blobsy` file.

### `blobsy sync`

One command to get fully synced.

```bash
$ blobsy sync
✓ .blobsy files committed
✓ Pulled 2 files from remote
✓ Pushed 1 file to remote
✓ Fully synced
```

Algorithm:

1. **Check:** `.blobsy` has uncommitted changes → error with instructions.
2. **Check:** Local files differ from manifest → warn per file.
3. **Pull:** Download any files listed in the manifest that are missing locally.
4. **Push:** Upload any blobs from the manifest that the remote doesn't have.
5. **Report:** Clean exit = fully synced.

Sync only moves blobs.
It never modifies the manifest.
The manifest is exclusively owned by `blobsy commit` + `git commit`.

### `blobsy resolve`

Helpers for resolving `.blobsy` merge conflicts after `git merge`:

```bash
$ blobsy resolve --ours data/research-batch/report.md
$ blobsy resolve --theirs data/research-batch/report.md
$ blobsy resolve --ours    # all conflicts
$ blobsy resolve --theirs  # all conflicts
```

During a git merge, the `.blobsy` file may have conflict markers on specific file
entries:

```yaml
  - path: data/results.json
<<<<<<< HEAD
    sha256: aaa111...
    size: 1048576
=======
    sha256: ccc333...
    size: 2097152
>>>>>>> origin/main
```

`blobsy resolve` parses these and picks the chosen side, producing a clean manifest.
After resolving, the user runs `blobsy push` to ensure the chosen blobs are in the
remote.

## Per-File State Model

Every tracked file has state across four layers:

| Layer | Symbol | What | Where |
| --- | --- | --- | --- |
| Local | **L** | Actual file on disk | `data/results.json` |
| Manifest | **M** | `.blobsy` working copy | `.blobsy` file on disk |
| Git | **G** | `.blobsy` in git HEAD | `git show HEAD:.blobsy` |
| Remote | **R** | Blob in remote store | `s3://bucket/prefix/...` |

Each layer has a hash value for the file, or `∅` (absent).

### State Table

**Clean states — everything committed:**

| # | L | M | G | R has G? | Description | `status` shows | `sync` does |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | h | h | h | yes | Fully synced | clean | nothing |
| 2 | h | h | h | no | Committed, not pushed | needs push | uploads blob |
| 3 | ∅ | h | h | yes | File missing locally | needs pull | downloads blob |
| 4 | ∅ | h | h | no | Missing everywhere | **data loss** | errors with warning |

**Local changes — before `blobsy commit`:**

| # | L | M | G | R has G? | Description | `status` shows | `sync` does |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | h' | h | h | yes | File modified locally | modified | warns "uncommitted changes" |
| 6 | h' | h | h | no | Modified + not pushed | modified, needs push | warns + uploads old blob |
| 7 | ∅ | h | h | yes | File deleted locally | deleted | warns "file deleted locally" |
| 8 | h | ∅ | ∅ | — | Untracked file | untracked | ignores |

**After `blobsy commit`, before `git commit`:**

| # | L | M | G | R has G? | Description | `status` shows | `sync` does |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | h' | h' | h | yes | Manifest updated, not git committed | uncommitted .blobsy | **errors**: "git commit .blobsy first" |
| 10 | h | h | ∅ | — | Newly tracked, not git committed | new (uncommitted) | **errors**: same |
| 11 | ∅ | ∅ | h | yes | Removed from tracking, not git committed | removed (uncommitted) | **errors**: same |

**Orphaned remote state:**

| # | L | M | G | R | Description | Action |
| --- | --- | --- | --- | --- | --- | --- |
| 12 | ∅ | ∅ | ∅ | has old blob | Orphaned remote blob | `blobsy gc` candidate |

### Key Invariant

`blobsy sync` succeeds cleanly **only when M = G** (manifest is committed).
When it succeeds with no warnings, you know:

- Manifest is committed in git.
- Remote has all blobs referenced by the manifest.
- Local has all files referenced by the manifest.
- You are fully synced.

`blobsy sync` **never modifies the manifest.**
It only moves blobs between local and remote.

## Conflict Model

### Why Conflicts Are Git-Only

Because `blobsy push` requires `.blobsy` to be git committed, every push targets a
unique prefix (unique git commit = unique timestamp + hash).
Two people pushing simultaneously write to different prefixes.
There is no remote contention.

The only conflict surface is `git merge` of the `.blobsy` file.

### Conflict Scenarios

**Scenario: Two people modify different files in the same directory.**

```
A: modifies report.md, blobsy commit, git commit, blobsy push
B: modifies response.json, blobsy commit, git commit, blobsy push
B: git pull → auto-merge succeeds (different lines in .blobsy)
B: blobsy push → uploads to new prefix
```

No conflict.
Git auto-merges because the changes are on different lines of the `.blobsy` file.

**Scenario: Two people modify the same file.**

```
A: modifies results.json, blobsy commit, git commit, blobsy push
B: modifies results.json, blobsy commit, git commit, blobsy push
B: git pull → CONFLICT on .blobsy (same path, different hashes)
```

Git surfaces the conflict:

```yaml
  - path: data/results.json
<<<<<<< HEAD
    sha256: aaa111...
    size: 1048576
=======
    sha256: ccc333...
    size: 2097152
>>>>>>> origin/main
```

Resolution options:

```bash
blobsy resolve --ours data/results.json     # keep my version
blobsy resolve --theirs data/results.json   # take their version
```

After resolving:

```bash
git add data/research-batch.blobsy
git commit
blobsy push    # ensures chosen blobs are in remote
```

**Scenario: One person adds a file, another deletes a file.**

No conflict.
Addition adds a new entry to the `files:` list, deletion removes a different entry.
Git auto-merges.

**Scenario: One person modifies a file, another deletes it.**

Git conflict on the `.blobsy` file: one side has the entry with a new hash, the other
side removed it.
Resolved manually or with `blobsy resolve`.

### Summary of Conflict Outcomes

| A does | B does | Git merge result | Resolution |
| --- | --- | --- | --- |
| Modify file X | Modify file Y | Auto-merge ✅ | None needed |
| Modify file X | Modify file X | Conflict ❌ | `blobsy resolve --ours/--theirs` |
| Add file X | Add file Y | Auto-merge ✅ | None needed |
| Add file X | Add file X (same path) | Conflict ❌ | `blobsy resolve` |
| Delete file X | Delete file X | Auto-merge ✅ | None needed |
| Modify file X | Delete file X | Conflict ❌ | `blobsy resolve` |
| Add file X | Delete file Y | Auto-merge ✅ | None needed |

## Workflow: Clean Sequential

The simplest case. No conflicts possible.

```
A: edit files
A: blobsy commit
A: git add .blobsy && git commit
A: blobsy push    → writes to 20260220T140322Z-a3f2b1c/
A: git push

B: git pull       → gets updated .blobsy
B: blobsy pull    → downloads from 20260220T140322Z-a3f2b1c/
B: edit files
B: blobsy commit
B: git add .blobsy && git commit
B: blobsy push    → writes to 20260220T151745Z-7d4e9f2/
B: git push
```

Each push writes to a unique prefix.
No coordination needed beyond normal git workflow.

## Workflow: Parallel Work with Merge

Two people working on the same tracked directory simultaneously.

```
A: git checkout -b feature-a
A: edit report.md
A: blobsy commit → updates .blobsy
A: git commit
A: blobsy push   → 20260220T140322Z-a3f2b1c/

B: git checkout -b feature-b
B: edit response.json
B: blobsy commit → updates .blobsy
B: git commit
B: blobsy push   → 20260220T141005Z-d4e5f6a/

# Merge feature-a into main
A: git checkout main && git merge feature-a
A: blobsy push   → 20260220T150000Z-b1c2d3e/
A: git push

# Merge feature-b into main (may conflict on .blobsy)
B: git checkout main && git pull
B: git merge feature-b
# If different files changed: auto-merge, done
# If same file changed: conflict on .blobsy → resolve → commit
B: blobsy push   → 20260220T153000Z-e6f7a8b/
B: git push
```

## Garbage Collection

Each push creates a new prefix.
Over time, old prefixes accumulate.
`blobsy gc` cleans them up.

### GC with Timestamp-Hash Prefixes

```bash
$ blobsy gc --dry-run
Scanning remote prefixes...
  20260215T093000Z-f1a2b3c/  → commit f1a2b3c unreachable  → REMOVE (120 MB)
  20260218T140322Z-a3f2b1c/  → commit a3f2b1c reachable    → KEEP
  20260220T151745Z-7d4e9f2/  → commit 7d4e9f2 reachable    → KEEP
Would remove: 1 prefix, 120 MB

$ blobsy gc
Removed: 20260215T093000Z-f1a2b3c/ (120 MB)
Done. 1 prefix removed, 120 MB freed.
```

Algorithm:

1. List all remote prefixes.
2. Extract the git hash from each prefix.
3. Check if the commit is reachable from any branch or tag (`git merge-base --is-ancestor`
   or similar).
4. Unreachable prefixes are garbage.

**Safety options:**

```bash
blobsy gc --dry-run                    # preview only
blobsy gc --older-than 30d             # only remove prefixes older than 30 days
blobsy gc --protect-branches "main,release/*"  # never remove prefixes from these branches
```

### GC with Content-Addressable Prefixes

When using `{file_hash}` template, GC checks whether any `.blobsy` file on any
reachable branch references the hash:

1. Collect all file hashes from all `.blobsy` files across reachable branches.
2. List all remote object keys.
3. Remove objects whose hash isn't referenced.

More expensive (must scan all `.blobsy` files across branches) but straightforward.

## Comparison with Main Design

| Aspect | Main design | Git-manifest alternative |
| --- | --- | --- |
| Manifest location | Remote (JSON file in S3) | Inline in `.blobsy` (git-versioned) |
| Remote state | Mutable (overwritten on push) | Immutable (each push = new prefix) |
| Conflict surface | Remote manifest + git pointer | Git only (`.blobsy` file merge) |
| `blobsy status` | Requires network (fetch manifest) | Fully offline |
| `blobsy push` precondition | None | `.blobsy` must be git committed |
| Post-merge gap | Must push to `branches/main/` | No gap (prefix is per-commit, not per-branch) |
| Cross-branch dedup | No (V1), yes (V2 versioned storage) | With `{file_hash}` template, yes from day 1 |
| Storage overhead | One copy per branch prefix | One copy per push (default) or deduplicated (`{file_hash}`) |
| Remote browsability | Files at `branches/main/path` | Files under `timestamp-hash/path` or flat hash keys |
| GC complexity | Check if branch exists | Check if commit is reachable (or hash is referenced) |
| Repo size impact | None (manifest is remote) | ~100 bytes per tracked file in `.blobsy` |
| Merge conflicts | Rare (pointer is just timestamp) | More common (pointer has file list) |
| History/reproducibility | Depends on S3 versioning | Every commit preserves its remote prefix |

## Open Design Questions

### How Does Pull Find the Right Remote Prefix?

After `git pull`, you have a `.blobsy` file with a manifest.
But which remote prefix contains the blobs?

Options:

1. **`remote_prefix` field in `.blobsy`.** Push writes it, git versions it.
   Simple, but ties the pointer to a specific push.
   Rebasing changes the commit hash, potentially invalidating the prefix.

2. **Derive from git log.** Walk history to find the commit that last touched `.blobsy`,
   reconstruct the prefix.
   No extra state, but requires git history and is fragile across rebases.

3. **Try multiple prefixes.** Use the manifest's `updated` timestamp and current commit
   hash to search.
   Robust but slower.

4. **Remote index file.** A small file at a known remote path that maps manifest hashes
   to prefixes.
   Push updates it.
   Pull reads it once.

Recommendation: option 1 (`remote_prefix` in `.blobsy`) for simplicity.
The rebase concern is minimal — after a rebase, you `blobsy push` to create a new
prefix for the new commit, which updates `remote_prefix`.

### Storage Efficiency: Default Template Duplicates Unchanged Files

With the default `{timestamp}-{git_hash_short}/` template, each push creates a full copy
of all tracked files under a new prefix.
If only one file changed, the other files are re-uploaded.

Mitigations:

1. **`{file_hash}` template** eliminates this entirely. Content-addressed = automatic
   dedup.
2. **Hybrid approach:** Push checks if the remote already has a file with the same hash
   under a previous prefix, and skips re-upload.
   The new prefix then references the old blob (requires either symlinks/redirects in
   the remote, or a manifest that records per-file remote paths).
3. **Accept the duplication** for the default template. Storage is cheap. Simplicity
   wins. Users who care about dedup can use `{file_hash}`.

Recommendation: start with option 3 (accept duplication) for simplicity.
Document `{file_hash}` as the optimization.
Consider option 2 as a future enhancement.

### Scaling Limits of Inline Manifest

The `.blobsy` file grows linearly with the number of tracked files.
At ~100 bytes per file entry:

| Files | `.blobsy` size | Git diff | Practical? |
| --- | --- | --- | --- |
| 100 | ~10 KB | Clean | Yes |
| 1,000 | ~100 KB | Fine | Yes |
| 10,000 | ~1 MB | Noisy but workable | Yes, with care |
| 100,000 | ~10 MB | Unwieldy | Consider external manifest |

For the 100K+ case, a future extension could support a `manifest: external` mode where
the `.blobsy` file stores only a hash of the full manifest, and the manifest itself is
stored remotely or in a separate git-tracked file.

### Relationship to `blobsy track` / `blobsy untrack`

`blobsy track <path>` would:

1. Create the `.blobsy` pointer file (as in main design).
2. Add the path to `.gitignore`.
3. Run `blobsy commit` to populate the initial manifest.

`blobsy untrack <path>` would:

1. Remove the `.blobsy` pointer file.
2. Remove the `.gitignore` entry.
3. Leave local files intact.

### Delete Semantics on Push

Since each push writes to a new prefix, there is no "delete from remote" during normal
operations.
If a file is removed from the manifest, it simply doesn't appear in the next push's
prefix.
The old prefix still has it.

This makes delete semantics trivial:

- No `--prune` flag needed.
- No tombstones in manifests.
- Old data is preserved until GC removes the prefix.

This resolves the open P0 issue from the main design (`blobsy-05j8`) cleanly.

## Summary

The git-manifest approach trades repo size (~100 bytes per tracked file in `.blobsy`) for
significant architectural simplification:

- No remote manifest coordination.
- No mutable remote state.
- No post-merge prefix gap.
- No push/pull conflicts outside of git.
- Offline status checks.
- Trivial delete semantics.
- Built-in history (every commit preserves its prefix).
- Optional content-addressable dedup via `{file_hash}` template.

The main cost is more frequent `.blobsy` merge conflicts, but these are structured
(path + hash entries) and can be tooled with `blobsy resolve`.
