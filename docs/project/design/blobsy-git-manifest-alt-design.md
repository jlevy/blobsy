# blobsy: Per-File Ref Design

**Status:** Draft

**Date:** 2026-02-20

**Supplements:** [blobsy-design.md](blobsy-design.md)

This document describes an alternative architecture that eliminates manifests entirely.
Every tracked file gets its own `.ref` file committed to git.
Directories are just the recursive case — no special handling needed.

Backend system, configuration hierarchy, transfer delegation, and other fundamentals
from the main design doc are unchanged.

## Motivation

The main design has two primitives: single-file pointers and directory pointers (with
manifests). The previous alternative (inline manifest) unified these into one pointer
file per tracked path. But there's a simpler option: eliminate manifests entirely.

**The insight:** a directory of tracked files is just a directory of `.ref` files.
No manifest needed — git is the manifest.

This collapses the design to a single primitive: one file, one `.ref`.

## Core Idea

For every large file you want to track:

```
data/bigfile.zip           ← actual file (gitignored)
data/bigfile.zip.ref       ← ref file (committed to git)
```

The `.ref` file contains the content hash, size, and the remote location of the blob.
It is a small YAML file committed to git.
The actual file is gitignored.

**That's the whole system.** There is no directory type, no manifest, no remote
coordination state. Git tracks `.ref` files. The remote is a dumb blob store.

### Directories Are Just Recursion

To track a directory, you track every file in it:

```
data/research/                          ← directory (gitignored)
data/research/report.md.ref             ← ref (committed)
data/research/raw/response.json.ref     ← ref (committed)
data/research/raw/data.parquet.ref      ← ref (committed)
```

`blobsy add data/research/` creates a `.ref` for every file, recursively.
Each `.ref` is independent.
Git diffs, merges, and conflicts work per-file, naturally.

## Ref File Format

```yaml
# blobsy — https://github.com/jlevy/blobsy

format: blobsy-ref/0.1
sha256: 7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_prefix: 20260220T140322Z-a3f2b1c
```

Fields:

| Field | Type | Description |
| --- | --- | --- |
| `format` | string | Format version (`blobsy-ref/0.1`) |
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

### `blobsy add`

Start tracking a file or directory.

```bash
# Single file
$ blobsy add data/bigfile.zip
Created data/bigfile.zip.ref
Added data/bigfile.zip to .gitignore

# Directory (recursive)
$ blobsy add data/research/
Created data/research/report.md.ref
Created data/research/raw/response.json.ref
Created data/research/raw/data.parquet.ref
Added data/research/ to .gitignore
3 files tracked.
```

What it does:

1. For each file (recursively for directories), compute SHA-256.
2. Create a `.ref` file adjacent to each file.
3. Add the original file(s) to `.gitignore`.

The `.ref` files are not yet git committed. The user does that:

```bash
$ git add data/bigfile.zip.ref
$ git commit -m "Track bigfile with blobsy"
```

**Ignore patterns** work the same as in the main design: configured in
`.blobsy/config.yml`, use gitignore syntax, applied during recursive add:

```yaml
# .blobsy/config.yml
ignore:
  - "*.py"
  - "__pycache__/"
  - ".DS_Store"
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

**Precondition: `.ref` files must be committed to git.**
If any `.ref` has uncommitted changes, sync errors:

```
Error: data/bigfile.zip.ref has uncommitted changes.
Run 'git add' and 'git commit' first.
```

Algorithm for each `.ref`:

1. **Read the ref** — get `sha256`, `size`, `remote_prefix`.
2. **Check local file** — hash it (using stat cache for speed).
3. **If local matches ref and remote has the blob:** nothing to do.
4. **If local matches ref but remote doesn't have it:** push (upload blob, set
   `remote_prefix` in ref).
5. **If local is missing but remote has the blob:** pull (download blob).
6. **If local differs from ref:** warn — file was modified locally but ref not updated.
   Sync does not overwrite local modifications.

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

1. Find all `.ref` files in the repo.
2. For each, compare local file hash against the ref's `sha256`.
3. Report: ok, modified, missing, not pushed (no `remote_prefix`).

No network access. The ref file has everything needed.

### `blobsy add` (Update Mode)

When files change, re-run `blobsy add` to update the refs:

```bash
# After modifying report.md
$ blobsy add data/research/report.md
Updated data/research/report.md.ref (sha256 changed)

# Or update all refs in a directory
$ blobsy add data/research/
Updated data/research/report.md.ref (sha256 changed)
2 files unchanged.

$ git add data/research/report.md.ref
$ git commit -m "Update report"
$ blobsy sync
```

`blobsy add` is idempotent. Running it on an already-tracked file updates the hash if
changed, or does nothing if unchanged.

### `blobsy rm`

Stop tracking a file or directory.

```bash
$ blobsy rm data/bigfile.zip
Removed data/bigfile.zip.ref
Removed data/bigfile.zip from .gitignore
(Local file data/bigfile.zip preserved)
```

Removes the `.ref` and `.gitignore` entry. Does not delete the local file or remote
blob.

## Per-File State Model

Each tracked file has state across three layers:

| Layer | What | Where |
| --- | --- | --- |
| **Local** | Actual file on disk | `data/bigfile.zip` |
| **Ref** | `.ref` committed in git | `data/bigfile.zip.ref` |
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

`blobsy sync` only operates on files whose `.ref` is committed to git.
It never modifies `.ref` files (except to set `remote_prefix` after a successful push).
The user controls the ref via `blobsy add` + `git commit`.

Sync succeeds cleanly when all three layers agree.

## Conflict Model

### Why Conflicts Are Trivially Resolved

Each file has its own `.ref`. Two people modifying different files change different
`.ref` files. Git auto-merges with zero conflicts.

The only conflict case: two people modify **the same file**. Then git sees a conflict on
that file's `.ref`:

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
$ git checkout --theirs data/results.json.ref
$ git add data/results.json.ref
$ blobsy pull data/results.json    # get their version of the actual file
```

### Comparison to Main Design Conflict Model

| Scenario | Main design | Per-file ref |
| --- | --- | --- |
| A modifies X, B modifies Y | Auto-merge (maybe, depends on manifest layout) | Auto-merge (always — different `.ref` files) |
| A modifies X, B modifies X | Remote manifest conflict + pointer conflict | Git conflict on `X.ref` only |
| A adds X, B adds Y | Auto-merge | Auto-merge (always — different `.ref` files) |
| A adds X, B adds X (same path) | Remote manifest conflict | Git conflict on `X.ref` |
| A deletes X, B modifies X | Complex (manifest + pointer) | Git conflict on `X.ref` |
| Resolution tool | `blobsy resolve` (custom) | `git checkout --ours/--theirs` (standard) |

**Key advantage:** conflicts are standard git conflicts on individual files.
No custom resolution tooling needed. Every developer already knows how to resolve git
conflicts.

## Workflows

### Single User: Track, Push, Pull

```bash
# Setup (one-time)
$ blobsy init
Created .blobsy/config.yml
? Bucket: my-datasets
? Region: us-east-1

# Track files
$ blobsy add data/model.bin
Created data/model.bin.ref
Added data/model.bin to .gitignore

# Commit refs to git
$ git add data/model.bin.ref .gitignore .blobsy/config.yml
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
A: blobsy add data/research/report.md    # updates .ref
A: git add data/research/report.md.ref && git commit -m "Update report"
A: blobsy sync                           # pushes blob
A: git push

# User B modifies data.parquet (concurrently)
B: python process.py  # writes data/research/data.parquet
B: blobsy add data/research/data.parquet
B: git add data/research/data.parquet.ref && git commit -m "Update data"
B: blobsy sync
B: git pull                              # auto-merge: different .ref files
B: git push
B: blobsy sync                           # pushes blob
```

No conflicts. Different files = different `.ref` files = auto-merge.

### Two Users: Same File Conflict

```bash
# User A modifies results.json
A: blobsy add data/results.json
A: git add data/results.json.ref && git commit
A: blobsy sync && git push

# User B also modified results.json
B: blobsy add data/results.json
B: git add data/results.json.ref && git commit
B: git pull
# CONFLICT on data/results.json.ref

# Resolve: take A's version
B: git checkout --theirs data/results.json.ref
B: git add data/results.json.ref
B: blobsy sync    # pulls A's version of the actual file
B: git commit -m "Resolve: take A's results"
B: git push
```

### Feature Branch and Merge

```bash
# Branch off
$ git checkout -b feature/new-data

# Work on the branch
$ blobsy add data/new-results.parquet
$ git add data/new-results.parquet.ref && git commit
$ blobsy sync && git push

# Merge back to main
$ git checkout main && git merge feature/new-data
# .ref files merge cleanly (new file = new .ref = no conflict)
$ blobsy sync    # blobs already in remote from feature branch push
$ git push
```

**No post-merge prefix gap.**
The blobs were pushed from the feature branch.
After merge, the `.ref` files on main point to the same blobs.
`blobsy sync` on main has nothing to do — the blobs are already there.

This completely eliminates the P0 issue from the main design (`blobsy-a64l`).

## Garbage Collection

With content-addressable layout (default), GC removes blobs not referenced by any
`.ref` file on any reachable branch:

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

1. Collect all `sha256` values from all `.ref` files across all reachable branches/tags.
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

`blobsy add` manages `.gitignore` entries, same as the main design:

```gitignore
# >>> blobsy-managed (do not edit) >>>
data/bigfile.zip
data/research/
# <<< blobsy-managed <<<
```

For directories, the entire directory is gitignored and the `.ref` files live alongside
the actual files *inside* the gitignored directory.

Wait — this is a problem. If `data/research/` is gitignored, then
`data/research/report.md.ref` is also gitignored. Git won't track it.

### Solving the Gitignore Problem

**Option A: Negation patterns.** Gitignore the directory but un-ignore `.ref` files:

```gitignore
# >>> blobsy-managed (do not edit) >>>
data/research/
!data/research/**/*.ref
# <<< blobsy-managed <<<
```

This works in git. The `.ref` files are tracked, everything else is ignored.
But it requires gitignore negation patterns, which can be confusing.

**Option B: `.ref` files live outside the tracked directory.** Instead of putting `.ref`
files inside the directory, put them in a parallel structure:

```
data/research/              ← actual files (gitignored)
  report.md
  raw/response.json
data/research.refs/         ← ref files (committed)
  report.md.ref
  raw/response.json.ref
```

Clean separation. The `.refs/` directory is committed, the data directory is gitignored.
But the parallel structure can be confusing and fragile.

**Option C: Single `.ref` file per directory with inline list (previous design).**
Falls back to the inline manifest for directories.

**Option D (recommended): `.ref` files inside the directory, with gitignore negation.**
Option A is the most natural. The `.ref` files live where the files are. Negation
patterns are a standard git feature, just less commonly used:

```gitignore
data/research/**
!data/research/**/*.ref
!data/research/**/
```

(The `!**/` line is needed so git traverses subdirectories to find `.ref` files.)

`blobsy add` generates these patterns automatically. Users don't write them by hand.

## Configuration

Minimal changes from the main design:

```yaml
# .blobsy/config.yml
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
  tool: auto
  parallel: 8

checksum:
  algorithm: sha256

ignore:
  - "__pycache__/"
  - "*.pyc"
  - ".DS_Store"
```

The `namespace.prefix` template concept from the main design is replaced by
`remote.layout`. There are no branch-based namespaces — the content hash or
timestamp-commit prefix handles isolation.

## Comparison with Main Design and Inline Manifest Alternative

| Aspect | Main design | Inline manifest alt | Per-file ref (this doc) |
| --- | --- | --- | --- |
| Tracked unit | File or directory | File or directory | File (always) |
| Manifest | Remote JSON | Inline in `.blobsy` | None (git is the manifest) |
| Files per tracked path | 1 `.blobsy` | 1 `.blobsy` | 1 `.ref` per file |
| Directory support | Directory pointer + manifest | Directory pointer + inline file list | Recursive `.ref` files |
| Conflict granularity | Per-pointer (whole directory) | Per-pointer (whole directory, but line-level merge) | Per-file (independent `.ref`) |
| Git merge | Rare conflicts on pointer | Structured conflicts on file list | Standard file conflicts (one `.ref` at a time) |
| Custom tooling needed | `blobsy resolve` | `blobsy resolve` | None (`git checkout --ours/--theirs`) |
| `blobsy commit` command | N/A | Yes (snapshot dir → manifest) | N/A (`blobsy add` per file) |
| Offline status | No (need remote manifest) | Yes | Yes |
| Post-merge gap | Yes (P0 issue) | No | No |
| Delete semantics | Complex (P0 issue) | Trivial | Trivial |
| Remote coordination | Manifest is shared mutable state | None (immutable prefixes) | None (content-addressed or immutable prefixes) |
| Repo clutter | 1 file per tracked path | 1 file per tracked path | 1 `.ref` per tracked file |
| Gitignore complexity | Simple | Simple | Needs negation patterns for directories |
| Scaling | Unlimited (manifest is remote) | ~10K files per pointer | Unlimited (one .ref per file, git handles it) |

## What This Design Eliminates

From the main design, the following concepts are no longer needed:

- **Manifests** (remote or inline) — gone entirely
- **Directory pointer type** — no `type: directory`, just files
- **`manifest_sha256`** — no manifest to hash
- **Namespace prefixes / branch isolation** — content-addressable dedup replaces branch
  prefixes
- **`blobsy commit`** — `blobsy add` handles hashing
- **`blobsy resolve`** — standard git conflict resolution works
- **`blobsy ns ls` / `blobsy ns show` / `blobsy gc` (branch-based)** — replaced by
  content-addressable GC
- **Post-merge promotion** — blobs are where they are, refs point to them
- **Delete semantics debate** — old blobs exist until GC, new pushes don't overwrite

## Open Design Questions

### Gitignore Negation Robustness

The `!**/*.ref` negation pattern is standard git, but less commonly used. Questions:

- Do all git clients handle this correctly? (Git CLI does. GitHub Desktop, VS Code,
  etc. should — it's part of the gitignore spec.)
- Does `.gitignore` interaction with nested `.gitignore` files cause surprises?
- Should `blobsy doctor` validate that `.ref` files are actually tracked by git?

### Number of `.ref` Files in Large Directories

A directory with 10,000 files creates 10,000 `.ref` files. Questions:

- Is this a problem for git performance? (Git handles millions of files routinely.)
- Is it annoying in file browsers? (The `.ref` files are interspersed with the actual
  files — but the actual files are gitignored, so `git ls-files` only shows `.ref`s.)
- Should there be an option to store `.ref` files in a parallel directory
  (`data/research.refs/`) for cleanliness?

### `remote_prefix` for Content-Addressable Layout

With content-addressable layout, the remote key is deterministic from the file hash.
Do we still need `remote_prefix` in the ref? The pull can reconstruct it from
`sha256/{hash}`.

If yes (keep it): the ref is self-contained, works even if the layout config changes.
If no (omit it): simpler ref format, but pull depends on knowing the layout.

Recommendation: keep it. A ref should be self-contained.

### Mixed Directories (Some Files in Git, Some in Blobsy)

A directory where some files are small (committed to git) and others are large (tracked
by blobsy). With per-file refs, this is natural — only the large files get `.ref` files
and gitignore entries. But:

- The gitignore patterns need to be per-file (not per-directory).
- `blobsy add` with ignore patterns handles this: files matching ignore patterns are
  skipped.
- The user may need to adjust `.gitignore` manually for fine-grained control.

This is essentially the same tradeoff as the main design's Scenario 3, but slightly
simpler because there's no directory-level pointer to worry about.

## Summary

The per-file ref design reduces blobsy to a single primitive:

**One file → one `.ref` → one blob.**

Everything else follows:

- Directories are just recursive application.
- Git is the manifest.
- Conflicts are per-file, resolved with standard git tools.
- The remote is a dumb blob store (content-addressable by default).
- No remote coordination, no mutable state, no manifests.
- Post-merge gaps and delete semantics are non-issues.

The main tradeoff is gitignore complexity for tracked directories (negation patterns).
