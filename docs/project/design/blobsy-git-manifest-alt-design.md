# blobsy: Per-File Ref Design

**Status:** Draft

**Date:** 2026-02-20

**Supplements:** [blobsy-design.md](blobsy-design.md)

This document describes an alternative architecture that eliminates manifests entirely.
Every tracked file gets its own `.yref` file committed to git.
Directories are just the recursive case — no special handling needed.

Backend system, configuration hierarchy, transfer delegation, and other fundamentals
from the main design doc are unchanged.

## Motivation

The main design has two primitives: single-file pointers and directory pointers (with
manifests). The previous alternative (inline manifest) unified these into one pointer
file per tracked path. But there's a simpler option: eliminate manifests entirely.

**The insight:** a directory of tracked files is just a directory of `.yref` files.
No manifest needed — git is the manifest.

This collapses the design to a single primitive: one file, one `.yref`.

## Core Idea

For every large file you want to track:

```
data/bigfile.zip           ← actual file (gitignored)
data/bigfile.zip.yref       ← ref file (committed to git)
```

The `.yref` file contains the content hash, size, and the remote location of the blob.
It is a small YAML file committed to git.
The actual file is gitignored.

**That's the whole system.** There is no directory type, no manifest, no remote
coordination state. Git tracks `.yref` files. The remote is a dumb blob store.

### Directories Are Just Recursion

To track a directory, you track every file in it:

```
data/research/                          ← directory (gitignored)
data/research/report.md.yref             ← ref (committed)
data/research/raw/response.json.yref     ← ref (committed)
data/research/raw/data.parquet.yref      ← ref (committed)
```

`blobsy track data/research/` creates a `.yref` for every file, recursively.
Each `.yref` is independent.
Git diffs, merges, and conflicts work per-file, naturally.

## Ref File Format

```yaml
# blobsy — https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
sha256: 7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_prefix: 20260220T140322Z-a3f2b1c
```

Fields:

| Field | Type | Description |
| --- | --- | --- |
| `format` | string | Format version (`blobsy-yref/0.1`) |
| `sha256` | string | 64-char lowercase hex, SHA-256 of the file content |
| `size` | integer | File size in bytes |
| `remote_prefix` | string | Remote prefix where the blob was pushed (set by `blobsy push`) |

That's it. Four fields.

**Why `remote_prefix` is in the ref:**
Pull needs to know where to find the blob.
Storing it in the ref means git versions it, and anyone who checks out the ref can pull
without additional state.
Push sets this field; it's empty (or absent) until the first push.

**Why no `updated` timestamp:**
Git already tracks when the file changed (`git log`).
A timestamp in the ref adds no information and creates meaningless diffs.

## Remote Storage Layout

### Default: Content-Addressable

The simplest remote layout stores files by their content hash:

```
s3://bucket/project/
  sha256/7a3f0e.../data/bigfile.zip
  sha256/b4c8d2.../data/research/report.md
  sha256/a1b2c3.../data/research/raw/response.json
```

The key is `sha256/{hash}/{repo-relative-path}`.
The path suffix is for human browsability — you can see what the file is.

Properties:

- **Automatic dedup.** Same content = same hash = same remote key. Never re-uploaded.
- **Immutable.** A key is never overwritten (same hash = same content).
- **No coordination.** Two people pushing the same file write the same key.
  S3 PUT is idempotent on identical content.
- **Browsable.** `aws s3 ls s3://bucket/project/sha256/7a3f0e.../` shows the file with
  its real name.

With content-addressable layout, `remote_prefix` in the ref is the `sha256/{hash}`
portion.

### Alternative: Timestamp-Hash Prefixes

For teams that want chronologically browsable remote storage:

```yaml
# .blobsy/config.yml
remote:
  layout: timestamp   # default: content-addressable
```

```
s3://bucket/project/
  20260220T140322Z-a3f2b1c/
    data/bigfile.zip
    data/research/report.md
    data/research/raw/response.json
  20260220T151745Z-7d4e9f2/
    data/research/report.md     ← only this file changed
```

This layout creates a snapshot prefix per push.
Unchanged files are re-uploaded (no dedup).
Simple and browsable, but uses more storage.

### Layout Comparison

| | Content-addressable (default) | Timestamp-hash |
| --- | --- | --- |
| Dedup | Automatic | None |
| Storage | Minimal | Grows per push |
| Browsability | By hash, then path | Chronological |
| Push speed | Only new content uploaded | All files every time |
| GC | Remove unreferenced hashes | Remove unreachable prefixes |

## Commands

### `blobsy track`

Start tracking a file or directory with blobsy.

```bash
# Single file — always externalizes, regardless of size rules
$ blobsy track data/bigfile.zip
Tracking data/bigfile.zip
Created data/bigfile.zip.yref
Added data/bigfile.zip to .gitignore

# Directory — applies externalization rules to decide per-file
$ blobsy track data/research/
Scanning data/research/...
  data/research/report.md          (12 KB, .md)    → kept in git
  data/research/config.yaml        (800 B, .yaml)  → kept in git
  data/research/model.bin          (500 MB, .bin)   → externalized (.yref)
  data/research/raw/response.json  (2 MB, .json)    → kept in git (never list)
  data/research/raw/data.parquet   (50 MB, .parquet) → externalized (.yref)
2 files tracked, 3 kept in git.
```

**Key distinction:**

- **Explicit file** (`blobsy track data/bigfile.zip`): always externalizes. You named
  the file — that's explicit intent.
- **Directory** (`blobsy track data/research/`): applies the `externalize` rules from
  `.blobsy.yml` (size threshold, always/never patterns) to decide per-file.

What it does:

1. For each file to externalize: compute SHA-256, create a `.yref` adjacent to the file,
   add the original file to `.gitignore`.
2. For directories: skip files that don't meet the externalization rules (they stay in
   git as normal files).
3. Skip files matching `ignore` patterns.

The `.yref` files are not yet git committed. The user does that:

```bash
$ git add data/bigfile.zip.yref
$ git commit -m "Track bigfile with blobsy"
```

`blobsy track` is idempotent. Running it on an already-tracked file updates the hash
if the file changed, or does nothing if unchanged. This makes it the single command for
both "start tracking" and "update after modification":

```bash
# After modifying a tracked file
$ blobsy track data/research/model.bin
Updated data/research/model.bin.yref (sha256 changed)

# Or refresh all tracked files in a directory
$ blobsy track data/research/
Updated data/research/model.bin.yref (sha256 changed)
1 file updated, 1 unchanged.
```

### `blobsy sync`

The primary sync command. Ensures local files and remote blobs match the committed refs.

```bash
$ blobsy sync
Syncing 4 tracked files...
  data/bigfile.zip                  ✓ up to date
  data/research/report.md           ↑ pushed (4 KB)
  data/research/raw/response.json   ↓ pulled (1.0 MB)
  data/research/raw/data.parquet    ✓ up to date
Done. 1 pushed, 1 pulled, 2 up to date.
```

**Precondition: `.yref` files must be committed to git.**
If any `.yref` has uncommitted changes, sync errors:

```
Error: data/bigfile.zip.yref has uncommitted changes.
Run 'git add' and 'git commit' first.
```

Algorithm for each `.yref`:

1. **Read the ref** — get `sha256`, `size`, `remote_prefix`.
2. **Check local file** — hash it (using stat cache for speed).
3. **If local matches ref and remote has the blob:** nothing to do.
4. **If local matches ref but remote doesn't have it:** push (upload blob, set
   `remote_prefix` in ref).
5. **If local is missing but remote has the blob:** pull (download blob).
6. **If local differs from ref:** warn — file was modified locally but ref not updated.
   Run `blobsy track` to update the ref first. Sync does not overwrite local
   modifications.

Each file is independent. Sync handles them all in parallel (up to `sync.parallel`
concurrent transfers).

### `blobsy push` / `blobsy pull`

Convenience aliases for one-directional sync:

```bash
$ blobsy push [path...]    # only upload, skip downloads
$ blobsy pull [path...]    # only download, skip uploads
```

Same precondition (refs must be committed).
Same per-file logic, just filtered to one direction.

### `blobsy status`

Show the state of all tracked files. **Fully offline.**

```bash
$ blobsy status
  data/bigfile.zip              ✓ ok
  data/research/report.md       modified (local ≠ ref)
  data/research/raw/resp.json   missing locally
  data/research/raw/data.parq   ✓ ok (not pushed)
```

What it does:

1. Find all `.yref` files in the repo.
2. For each, compare local file hash against the ref's `sha256`.
3. Report: ok, modified, missing, not pushed (no `remote_prefix`).

No network access. The ref file has everything needed.

### `blobsy untrack`

Stop tracking a file or directory.

```bash
$ blobsy untrack data/bigfile.zip
Untracked data/bigfile.zip
Removed data/bigfile.zip.yref
Removed data/bigfile.zip from .gitignore
(Local file preserved)

# Directory (recursive)
$ blobsy untrack data/research/
Untracked 2 files in data/research/
Removed data/research/model.bin.yref
Removed data/research/raw/data.parquet.yref
(Local files preserved)
```

Removes the `.yref` and `.gitignore` entry. Does not delete local files or remote blobs.
The user then `git add` + `git commit` to finalize the untracking.

## Per-File State Model

Each tracked file has state across three layers:

| Layer | What | Where |
| --- | --- | --- |
| **Local** | Actual file on disk | `data/bigfile.zip` |
| **Ref** | `.yref` committed in git | `data/bigfile.zip.yref` |
| **Remote** | Blob in remote store | `s3://bucket/.../bigfile.zip` |

### State Table

Let `L` = local file hash, `R` = ref hash (in git HEAD), `B` = blob exists in remote.

| L | R | B | State | `status` | `sync` |
| --- | --- | --- | --- | --- | --- |
| h | h | yes | **Synced** | ok | nothing |
| h | h | no | **Needs push** | ok (not pushed) | pushes blob |
| ∅ | h | yes | **Needs pull** | missing | pulls blob |
| ∅ | h | no | **Data loss** | missing (no remote!) | errors |
| h' | h | yes | **Modified locally** | modified | warns |
| h' | h | no | **Modified + not pushed** | modified (not pushed) | warns |
| h | ∅ | — | **Untracked** | (not shown) | (ignored) |
| ∅ | ∅ | old | **Orphaned remote** | (not shown) | `gc` candidate |

### Key Invariant

`blobsy sync` only operates on files whose `.yref` is committed to git.
It never modifies `.yref` files (except to set `remote_prefix` after a successful push).
The user controls the ref via `blobsy track` + `git commit`.

Sync succeeds cleanly when all three layers agree.

## Conflict Model

### Why Conflicts Are Trivially Resolved

Each file has its own `.yref`. Two people modifying different files change different
`.yref` files. Git auto-merges with zero conflicts.

The only conflict case: two people modify **the same file**. Then git sees a conflict on
that file's `.yref`:

```
<<<<<<< HEAD
sha256: aaa111...
size: 1048576
=======
sha256: ccc333...
size: 2097152
>>>>>>> origin/main
```

Resolution is the same as any git conflict: pick one side, or merge manually.

```bash
# Accept theirs
$ git checkout --theirs data/results.json.yref
$ git add data/results.json.yref
$ blobsy pull data/results.json    # get their version of the actual file
```

### Comparison to Main Design Conflict Model

| Scenario | Main design | Per-file ref |
| --- | --- | --- |
| A modifies X, B modifies Y | Auto-merge (maybe, depends on manifest layout) | Auto-merge (always — different `.yref` files) |
| A modifies X, B modifies X | Remote manifest conflict + pointer conflict | Git conflict on `X.yref` only |
| A adds X, B adds Y | Auto-merge | Auto-merge (always — different `.yref` files) |
| A adds X, B adds X (same path) | Remote manifest conflict | Git conflict on `X.yref` |
| A deletes X, B modifies X | Complex (manifest + pointer) | Git conflict on `X.yref` |
| Resolution tool | `blobsy resolve` (custom) | `git checkout --ours/--theirs` (standard) |

**Key advantage:** conflicts are standard git conflicts on individual files.
No custom resolution tooling needed. Every developer already knows how to resolve git
conflicts.

## Workflows

### Single User: Track, Push, Pull

```bash
# Setup (one-time)
$ blobsy init
Created .blobsy.yml
? Bucket: my-datasets
? Region: us-east-1

# Track files
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore

# Commit refs to git
$ git add data/model.bin.yref .gitignore .blobsy.yml
$ git commit -m "Track model with blobsy"

# Push blobs to remote
$ blobsy sync
  data/model.bin   ↑ pushed (500 MB)
Done. 1 pushed.

# Push git
$ git push
```

On another machine:

```bash
$ git clone <repo>
$ blobsy sync
  data/model.bin   ↓ pulled (500 MB)
Done. 1 pulled.
```

### Two Users: Non-Conflicting Changes

```bash
# User A modifies report.md
A: vim data/research/report.md
A: blobsy track data/research/report.md    # updates .yref
A: git add data/research/report.md.yref && git commit -m "Update report"
A: blobsy sync                             # pushes blob
A: git push

# User B modifies data.parquet (concurrently)
B: python process.py  # writes data/research/data.parquet
B: blobsy track data/research/data.parquet
B: git add data/research/data.parquet.yref && git commit -m "Update data"
B: blobsy sync
B: git pull                              # auto-merge: different .yref files
B: git push
B: blobsy sync                           # pushes blob
```

No conflicts. Different files = different `.yref` files = auto-merge.

### Two Users: Same File Conflict

```bash
# User A modifies results.json
A: blobsy track data/results.json
A: git add data/results.json.yref && git commit
A: blobsy sync && git push

# User B also modified results.json
B: blobsy track data/results.json
B: git add data/results.json.yref && git commit
B: git pull
# CONFLICT on data/results.json.yref

# Resolve: take A's version
B: git checkout --theirs data/results.json.yref
B: git add data/results.json.yref
B: blobsy sync    # pulls A's version of the actual file
B: git commit -m "Resolve: take A's results"
B: git push
```

### Feature Branch and Merge

```bash
# Branch off
$ git checkout -b feature/new-data

# Work on the branch
$ blobsy track data/new-results.parquet
$ git add data/new-results.parquet.yref && git commit
$ blobsy sync && git push

# Merge back to main
$ git checkout main && git merge feature/new-data
# .yref files merge cleanly (new file = new .yref = no conflict)
$ blobsy sync    # blobs already in remote from feature branch push
$ git push
```

**No post-merge prefix gap.**
The blobs were pushed from the feature branch.
After merge, the `.yref` files on main point to the same blobs.
`blobsy sync` on main has nothing to do — the blobs are already there.

This completely eliminates the P0 issue from the main design (`blobsy-a64l`).

## Garbage Collection

With content-addressable layout (default), GC removes blobs not referenced by any
`.yref` file on any reachable branch:

```bash
$ blobsy gc --dry-run
Scanning refs across all branches...
Scanning remote blobs...
  sha256/7a3f0e... referenced by main, feature/x   → KEEP
  sha256/b4c8d2... referenced by main               → KEEP
  sha256/old123... not referenced                    → REMOVE (50 MB)
Would remove: 1 blob, 50 MB

$ blobsy gc
Removed: sha256/old123.../data/old-file.bin (50 MB)
Done. 1 blob removed, 50 MB freed.
```

Algorithm:

1. Collect all `sha256` values from all `.yref` files across all reachable branches/tags.
2. List all remote objects.
3. Remove objects whose hash isn't in the referenced set.

**Safety:**

```bash
blobsy gc --dry-run              # preview only
blobsy gc --older-than 30d       # only remove blobs older than 30 days
```

With timestamp-hash layout, GC removes entire prefixes whose git commit is unreachable
(same as the previous alternative design).

## Gitignore Management

`blobsy track` manages `.gitignore` entries, same as the main design:

```gitignore
# >>> blobsy-managed (do not edit) >>>
data/bigfile.zip
data/research/
# <<< blobsy-managed <<<
```

For directories, the entire directory is gitignored and the `.yref` files live alongside
the actual files *inside* the gitignored directory.

Wait — this is a problem. If `data/research/` is gitignored, then
`data/research/report.md.yref` is also gitignored. Git won't track it.

### Solving the Gitignore Problem

**Option A: Negation patterns.** Gitignore the directory but un-ignore `.yref` files:

```gitignore
# >>> blobsy-managed (do not edit) >>>
data/research/
!data/research/**/*.yref
# <<< blobsy-managed <<<
```

This works in git. The `.yref` files are tracked, everything else is ignored.
But it requires gitignore negation patterns, which can be confusing.

**Option B: `.yref` files live outside the tracked directory.** Instead of putting `.yref`
files inside the directory, put them in a parallel structure:

```
data/research/              ← actual files (gitignored)
  report.md
  raw/response.json
data/research.yrefs/         ← ref files (committed)
  report.md.yref
  raw/response.json.yref
```

Clean separation. The `.yrefs/` directory is committed, the data directory is gitignored.
But the parallel structure can be confusing and fragile.

**Option C: Single `.yref` file per directory with inline list (previous design).**
Falls back to the inline manifest for directories.

**Option D (recommended): `.yref` files inside the directory, with gitignore negation.**
Option A is the most natural. The `.yref` files live where the files are. Negation
patterns are a standard git feature, just less commonly used:

```gitignore
data/research/**
!data/research/**/*.yref
!data/research/**/
```

(The `!**/` line is needed so git traverses subdirectories to find `.yref` files.)

`blobsy track` generates these patterns automatically. Users don't write them by hand.

## Configuration: `.blobsy.yml`

Configuration lives in `.blobsy.yml` files, placed anywhere — like `.gitignore` or
`.editorconfig`. Each file applies to its directory and all descendants.

### Hierarchy

Five levels, each overriding the one above:

```
(blobsy built-in defaults)           Hardcoded in blobsy itself
~/.blobsy.yml                        User-global defaults
<repo>/.blobsy.yml                   Repo root
<repo>/data/.blobsy.yml              Subdirectory override
<repo>/data/research/.blobsy.yml     Deeper override
```

Resolution is bottom-up: the most specific `.blobsy.yml` wins.
Settings merge — a subdirectory file only needs to specify what it overrides.
If no `.blobsy.yml` exists anywhere, the built-in defaults apply.

### Built-in Defaults

These are compiled into blobsy and form the implicit base of every hierarchy.
Any `.blobsy.yml` at any level can override any part of this:

```yaml
# blobsy built-in defaults (not a file — hardcoded in blobsy)

externalize:
  min_size: 1mb
  always:
    - "*.parquet"
    - "*.bin"
    - "*.weights"
    - "*.onnx"
    - "*.safetensors"
    - "*.pkl"
    - "*.pt"
    - "*.h5"
    - "*.arrow"
    - "*.sqlite"
    - "*.db"
  never: []

compress:
  min_size: 100kb
  algorithm: zstd
  always:
    - "*.json"
    - "*.csv"
    - "*.tsv"
    - "*.txt"
    - "*.jsonl"
    - "*.xml"
    - "*.sql"
  never:
    - "*.gz"
    - "*.zst"
    - "*.zip"
    - "*.tar.*"
    - "*.parquet"
    - "*.png"
    - "*.jpg"
    - "*.jpeg"
    - "*.mp4"
    - "*.webp"
    - "*.avif"

ignore:
  - "__pycache__/"
  - "*.pyc"
  - ".DS_Store"
  - "node_modules/"
  - ".git/"
  - ".blobsy.yml"

remote:
  layout: content-addressable

sync:
  tool: auto
  parallel: 8

checksum:
  algorithm: sha256
```

This means blobsy works out of the box with zero configuration.
`blobsy track data/` uses sensible rules even if no `.blobsy.yml` exists.
The only thing that *must* be configured is the backend (bucket, region, etc.) —
everything else has a working default.

### Externalization Rules

When `blobsy track <dir>` runs, it decides which files get externalized (`.yref` +
gitignored) vs. left alone (committed directly to git). The decision is based on
**size** and **file type**:

```yaml
# .blobsy.yml
externalize:
  min_size: 1mb                    # files below this stay in git (default: 1mb)
  always:                          # always externalize these, regardless of size
    - "*.parquet"
    - "*.bin"
    - "*.weights"
    - "*.onnx"
  never:                           # never externalize these, regardless of size
    - "*.md"
    - "*.yaml"
    - "*.json"
```

**How it works with `blobsy track`:**

```bash
$ blobsy track data/research/
  data/research/report.md          (12 KB, .md)    → kept in git
  data/research/config.yaml        (800 B, .yaml)  → kept in git
  data/research/model.bin          (500 MB, .bin)   → externalized (.yref)
  data/research/raw/response.json  (2 MB, .json)    → kept in git (never list)
  data/research/raw/data.parquet   (50 MB, .parquet) → externalized (.yref)
3 files kept in git, 2 externalized.
```

This eliminates the "mixed directory" problem entirely. `blobsy track` on a directory
is smart by default — small text files stay in git, large binaries get `.yref` files.
No manual per-file decisions needed.

### Compression Rules

Blobsy can compress files before uploading to the remote, and decompress on pull.
Compression is controlled by **file type** and **size**:

```yaml
# .blobsy.yml
compress:
  min_size: 100kb                  # don't bother compressing tiny files
  algorithm: zstd                  # zstd (default) | gzip | none
  always:                          # always compress these
    - "*.json"
    - "*.csv"
    - "*.tsv"
    - "*.txt"
    - "*.jsonl"
    - "*.xml"
    - "*.sql"
  never:                           # never compress these (already compressed)
    - "*.gz"
    - "*.zst"
    - "*.zip"
    - "*.tar.*"
    - "*.parquet"
    - "*.png"
    - "*.jpg"
    - "*.jpeg"
    - "*.mp4"
    - "*.webp"
    - "*.avif"
```

When a file is compressed, the `.yref` records this:

```yaml
# blobsy — https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
sha256: 7a3f0e...          # hash of the ORIGINAL file (not the compressed blob)
size: 15728640             # size of the ORIGINAL file
remote_prefix: sha256/7a3f0e...
compressed: zstd           # compression used for the remote blob
compressed_size: 4194304   # size of the compressed blob in remote
```

The hash is always of the original file — this ensures that `blobsy status` can verify
integrity by hashing the local file without decompressing anything.

### Ignore Patterns

Same as the main design, now in `.blobsy.yml`. The built-in defaults cover common
patterns (`__pycache__/`, `.DS_Store`, `node_modules/`, `.git/`). Repos and
subdirectories can add their own.

### Backend and Sync Settings

Backend and sync settings live in the repo-root `.blobsy.yml` (or user-global).
These don't cascade per-directory — a file is pushed to one backend.

```yaml
# .blobsy.yml (repo root)
backend: default

backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: project-v1/
    region: us-east-1

remote:
  layout: content-addressable    # default | timestamp

sync:
  tool: auto                     # auto | aws-cli | s5cmd | rclone
  parallel: 8
```

### Full Example

A repo with sensible defaults at the root and an override for a data-heavy subdirectory:

```yaml
# <repo>/.blobsy.yml — repo root
backend: default
backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: my-project/
    region: us-east-1

externalize:
  min_size: 1mb

compress:
  algorithm: zstd

ignore:
  - "__pycache__/"
  - ".DS_Store"
```

```yaml
# <repo>/data/raw/.blobsy.yml — override for raw data dir
externalize:
  min_size: 0                     # externalize everything here, even small files
  never: []                       # no exceptions

compress:
  never:                          # raw data is already compressed
    - "*.parquet"
    - "*.gz"
```

### What This Enables

The combination of per-directory `.blobsy.yml`, externalization rules, and compression
rules means:

- **`blobsy track <dir>` just works.** No manual per-file decisions. The rules decide
  what's externalized and what stays in git.
- **Compression is automatic.** Text-like formats get compressed. Already-compressed
  formats are left alone. Users don't think about it.
- **Overrides are local.** A `data/raw/.blobsy.yml` can say "externalize everything,
  compress nothing" without affecting the rest of the repo.
- **User defaults travel.** `~/.blobsy.yml` sets your preferred compression algorithm,
  default ignore patterns, etc. across all repos.

## Comparison with Main Design and Inline Manifest Alternative

| Aspect | Main design | Inline manifest alt | Per-file ref (this doc) |
| --- | --- | --- | --- |
| Tracked unit | File or directory | File or directory | File (always) |
| Manifest | Remote JSON | Inline in `.blobsy` | None (git is the manifest) |
| Files per tracked path | 1 `.blobsy` | 1 `.blobsy` | 1 `.yref` per file |
| Directory support | Directory pointer + manifest | Directory pointer + inline file list | Recursive `.yref` files |
| Conflict granularity | Per-pointer (whole directory) | Per-pointer (whole directory, but line-level merge) | Per-file (independent `.yref`) |
| Git merge | Rare conflicts on pointer | Structured conflicts on file list | Standard file conflicts (one `.yref` at a time) |
| Custom tooling needed | `blobsy resolve` | `blobsy resolve` | None (`git checkout --ours/--theirs`) |
| `blobsy commit` command | N/A | Yes (snapshot dir → manifest) | N/A (`blobsy track` per file) |
| Offline status | No (need remote manifest) | Yes | Yes |
| Post-merge gap | Yes (P0 issue) | No | No |
| Delete semantics | Complex (P0 issue) | Trivial | Trivial |
| Remote coordination | Manifest is shared mutable state | None (immutable prefixes) | None (content-addressed or immutable prefixes) |
| Repo clutter | 1 file per tracked path | 1 file per tracked path | 1 `.yref` per tracked file |
| Gitignore complexity | Simple | Simple | Needs negation patterns for directories |
| Scaling | Unlimited (manifest is remote) | ~10K files per pointer | Unlimited (one .yref per file, git handles it) |

## What This Design Eliminates

From the main design, the following concepts are no longer needed:

- **Manifests** (remote or inline) — gone entirely
- **Directory pointer type** — no `type: directory`, just files
- **`manifest_sha256`** — no manifest to hash
- **Namespace prefixes / branch isolation** — content-addressable dedup replaces branch
  prefixes
- **`blobsy commit`** — `blobsy track` handles hashing (idempotent: track + update)
- **`blobsy resolve`** — standard git conflict resolution works
- **`blobsy ns ls` / `blobsy ns show` / `blobsy gc` (branch-based)** — replaced by
  content-addressable GC
- **Post-merge promotion** — blobs are where they are, refs point to them
- **Delete semantics debate** — old blobs exist until GC, new pushes don't overwrite

## Open Design Questions

### Gitignore Negation Robustness

The `!**/*.yref` negation pattern is standard git, but less commonly used. Questions:

- Do all git clients handle this correctly? (Git CLI does. GitHub Desktop, VS Code,
  etc. should — it's part of the gitignore spec.)
- Does `.gitignore` interaction with nested `.gitignore` files cause surprises?
- Should `blobsy doctor` validate that `.yref` files are actually tracked by git?

### Number of `.yref` Files in Large Directories

A directory with 10,000 files creates 10,000 `.yref` files. Questions:

- Is this a problem for git performance? (Git handles millions of files routinely.)
- Is it annoying in file browsers? (The `.yref` files are interspersed with the actual
  files — but the actual files are gitignored, so `git ls-files` only shows `.yref`s.)
- Should there be an option to store `.yref` files in a parallel directory
  (`data/research.yrefs/`) for cleanliness?

### `remote_prefix` for Content-Addressable Layout

With content-addressable layout, the remote key is deterministic from the file hash.
Do we still need `remote_prefix` in the ref? The pull can reconstruct it from
`sha256/{hash}`.

If yes (keep it): the ref is self-contained, works even if the layout config changes.
If no (omit it): simpler ref format, but pull depends on knowing the layout.

Recommendation: keep it. A ref should be self-contained.

### Mixed Directories (Some Files in Git, Some in Blobsy)

Resolved by externalization rules. `blobsy track <dir>` uses `min_size`, `always`, and
`never` patterns to decide per-file. Small text files stay in git; large binaries get
`.yref` files. No manual decisions needed.

For mixed directories, gitignore entries are per-file (not per-directory), since only
some files are externalized. `blobsy track` manages these automatically.

## Summary

The per-file ref design reduces blobsy to a single primitive:

**One file → one `.yref` → one blob.**

Everything else follows:

- Directories are just recursive application.
- Git is the manifest.
- Conflicts are per-file, resolved with standard git tools.
- The remote is a dumb blob store (content-addressable by default).
- No remote coordination, no mutable state, no manifests.
- Post-merge gaps and delete semantics are non-issues.

The main tradeoff is gitignore complexity for tracked directories (negation patterns).

Layered `.blobsy.yml` configuration adds automatic externalization (by size and type)
and compression (by type), so `blobsy track <dir>` makes smart per-file decisions with
no manual intervention.
