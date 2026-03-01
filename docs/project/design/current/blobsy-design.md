# blobsy: Large Object Storage for Git Repos

**Status:** Draft

**Date:** 2026-02-21

**Companion documents:**

- [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md) --
  backend types, transfer delegation, atomic writes, error handling, health checks
- [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md) -- stat cache entry format,
  storage layout, three-way merge algorithm, cache update rules, and recovery

A standalone CLI for per-file sync of large files between local gitignored paths and
remote storage, with committed `.bref` pointer files for tracking.
Git is the manifest.

## Goals and Principles

1. **Simple:** Simple usage is easy.
   `blobsy track`, `blobsy push`, `blobsy pull`. No configuration required beyond a
   backend URL.

2. **CLI only:** No daemon, no server, no GUI. Pure stateless CLI that reads ref files,
   does work, exits.

3. **Self-documenting:** Humans and agents learn to use it by running it.
   Every `.bref` file has a header comment explaining what it is and how to get help.
   Rich `--help` on every command.
   `--json` output for agents.
   Works well as a skill in agent toolchains.

4. **Customizable with sensible defaults:** Hierarchical config at file, directory,
   repo, and home folder levels.
   Zero config needed for common cases; full control available when needed.

5. **Flexible:** Works with any file types, any directory structures.
   No renaming of files or directories.
   Just gitignore the target and put a `.bref` file next to it.
   Remote storage layout is also flexible: choose a clean, flat layout that mirrors your
   local paths (browsable with `aws s3 ls`, compatible with any S3 tool), or use
   content-addressable storage for automatic dedup.

6. **Transparent storage format:** Remote storage is readable and understandable.
   Files are stored with their original names.
   Browsable with standard tools (`aws s3 ls`, web consoles, rclone).
   No opaque databases.
   Other tools and scripts can read the remote directly -- blobsy doesn’t lock you in.
   Even with content-addressable layout, each blob retains its original filename for
   discoverability.

7. **Externalize everything:** Blobsy does as little as possible itself.
   It delegates to systems that already solve each subproblem well:

| Concern | Delegated to | Blobsy’s role |
| --- | --- | --- |
| Manifest / file tracking | Git (`.bref` files are git-versioned) | Creates and updates `.bref` files |
| Conflict resolution | Git (standard merge on `.bref` files) | Detects payload-vs-ref desync (see [stat cache](blobsy-stat-cache-design.md)); git handles `.bref` merges |
| File transfer | External CLI tools (`aws-cli`, `rclone`) or template commands | Orchestrates concurrency |
| Storage | Cloud providers (S3, GCS, Azure, etc.) | Constructs keys, issues commands |
| Compression | Node.js built-in `node:zlib` (`zstd`, `gzip`, `brotli`) | Decides what to compress, applies rules |
| History / versioning | Git (commit history of `.bref` files) | Nothing -- git handles it |

8. **Infrastructure neutral:** Pluggable backend (S3, R2, local, custom command),
   configurable transfer tools (aws-cli, rclone, or arbitrary template commands).
   Compression via Node.js built-in zstd.

9. **One primitive:** The entire system reduces to: one file, one `.bref`, one blob.
   Directories, sync, conflicts, GC -- all follow from this.
   There is no second kind of thing.

10. **Unopinionated where it doesn’t matter:** Blobsy doesn’t care what compression you
    use or which transfer tool you prefer.
    It cares about the contract: a `.bref` file points to a blob, and the blob must be
    reachable. Everything else is pluggable.

11. **Deterministic by design:** Blobsy operations are predictable and reproducible.
    Same content produces same hash.
    Same configuration produces same remote keys.
    `.bref` files use stable field ordering to minimize git diff noise.
    Content-addressable storage ensures multiple users pushing identical content produce
    identical remote blobs.
    This determinism enables reliable team collaboration, reproducible builds, and
    predictable storage costs.

## Design Decisions

These are cross-cutting decisions that shape the implementation and testing strategy.

### Idempotent Operations

Every operation that reasonably can be idempotent is idempotent.
Re-running any sync operation is always safe and converges to the same state:

- `blobsy track` on an already-tracked file: updates hash if content changed, no-op if
  unchanged.
- `blobsy push` when the remote already has the blob: no-op (content-addressable = same
  hash = same key = already exists).
- `blobsy pull` when the local file already matches the ref: no-op.
- `blobsy sync` when everything is in sync: no-op.
- `blobsy status`, `blobsy verify`, `blobsy doctor`: read-only, trivially idempotent.

Structural commands (`untrack`, `rm`, `mv`) are not repeatable by nature, but fail
safely on a second invocation rather than causing damage.

This matters for reliability: interrupted operations can always be retried.
Scripts, CI pipelines, and agent tool loops can call blobsy without worrying about
double-execution.

### No Daemon, No Lock Files

Pure CLI. Each invocation reads ref files and config from disk, does work, updates ref
files, exits. No background processes, no lock files, no coordination between
invocations. The only persistent local state is the stat cache (see
[blobsy-stat-cache-design.md](blobsy-stat-cache-design.md)), which is machine-local and
gitignored.

This simplicity means blobsy works in any environment (containers, CI runners, remote
shells) without setup, and never has stale state from a crashed daemon.

### Transparent Testing via Local Backend

The `local` backend (`local:../some-dir`) makes the entire system testable without cloud
credentials. Integration tests use a temp directory as the “remote” -- push writes files
there, pull reads them back.
Every code path (compression, hashing, atomic writes, conflict detection) exercises
identically to production S3 usage, just with a filesystem destination.

This means development and CI require zero cloud infrastructure.

### Golden Tests for All User-Facing Output

Blobsy uses golden/snapshot tests for **all user-facing output**, not just error
messages. Status output, sync summaries, doctor diagnostics, `--json` output shapes, and
error messages are all snapshot-tested.
This ensures:

- Output formats remain stable across releases (no accidental breakage for scripts
  parsing `--json`).
- Error messages stay helpful and consistent (error UX is critical).
- Human-readable formatting doesn’t regress.
- CI fails on any unintentional output change; intentional changes require explicit
  snapshot updates.

See [blobsy-testing-design.md](blobsy-testing-design.md) for the full testing plan,
including error scenario test cases, integration test structure, and golden test
implementation patterns.

## Related Work

A survey of existing tools shows no single solution cleanly fills this role.
Each has a fundamental gap.

### Git LFS

Git-native large file tracking via pointer files and a custom transfer protocol.

- **Relevant:** Closest architectural model -- pointer files in git, data stored
  externally.
- **Gaps:** Tied to hosting provider (requires server-side LFS support).
  No pluggable backends.
  No compression control.
  Requires Git hooks and `git lfs install` setup.
  No bidirectional sync outside of Git push/pull.
  No branch-isolated storage.

### DVC (Data Version Control)

Git-native dataset versioning with `.dvc` pointer files and pluggable remote storage.

- **Relevant:** Pointer files, pluggable backends (10+), content-addressable local
  cache.
- **Gaps:** Python dependency.
  MD5 hashing (not SHA-256). Content-addressable storage makes remote files
  non-browsable (stored by hash, not by path).
  No bidirectional sync.
  Tightly coupled to Git commit model.

### rclone

Multi-cloud file sync engine supporting 70+ storage backends.

- **Relevant:** Mature sync logic, excellent backend coverage.
  Strong candidate as a delegated transfer engine.
- **Gaps:** No manifest/pointer layer.
  No git integration. No versioning.
  No caching between invocations.
  Raw file sync only -- no coordination layer.

### Hugging Face Hub

Dataset hosting with lazy download and content-addressable local cache.

- **Relevant:** Best-in-class lazy caching model.
  Content-defined chunking (Xet) for sub-file dedup.
- **Gaps:** Tied to Hugging Face platform.
  Not a general-purpose tool.

### LakeFS

Git-like branching for object storage at the S3 API level.

- **Relevant:** Merkle tree sync patterns, branching model.
- **Gaps:** Heavy infrastructure (server + database).
  Designed for data lake scale (TB+). Overkill for file-level external storage.

### OCI/ORAS

OCI container registries repurposed for arbitrary artifact storage.

- **Relevant:** Content-addressable layers, built-in tagging, ubiquitous infrastructure.
- **Gaps:** Designed for layered images, not file trees.
  No per-file access within layers.
  Registry size limits.
  Awkward granularity model.

### Assessment

No existing tool combines: committed pointer files for git integration, pluggable
backends, content-addressable remote storage with dedup, push/pull sync with per-file
compression, and a simple standalone CLI. `blobsy` fills this gap as a per-file sync
coordinator that delegates heavy lifting to existing tools.

## Core Concepts

### The `.bref` Convention

For every tracked file, a `.bref` ref file sits adjacent to it with the same name plus
`.bref` appended:

```
data/bigfile.zip           <- actual file (gitignored)
data/bigfile.zip.bref       <- ref file (committed to git)
```

The `.bref` file is committed to git.
The actual data is gitignored.
`blobsy` manages `.gitignore` entries automatically.

**That’s the whole system.** There is no directory type, no manifest, no remote
coordination state. Git tracks `.bref` files.
The remote is a dumb blob store.

### Directories Are Just Recursion

To track a directory, you track every file in it:

```
data/research/                          <- directory (gitignored files within)
data/research/report.md.bref             <- ref (committed)
data/research/raw/response.json.bref     <- ref (committed)
data/research/raw/data.parquet.bref      <- ref (committed)
```

`blobsy track data/research/` creates a `.bref` for every file that meets the
externalization rules, recursively.
Each `.bref` is independent.
Git diffs, merges, and conflicts work per-file, naturally.

### Externalization Rule Precedence

When multiple rules could apply to a file, blobsy uses the following precedence order:

**Priority Order:**

1. **`externalize.never` patterns** (highest priority)
   - If file matches any `never` pattern → **NOT externalized** (even if matches
     `always`)
   - Example: `*.md` in never list → README.md not externalized

2. **`externalize.always` patterns**
   - If file matches any `always` pattern (and no `never` pattern) → **Externalized**
   - Example: `*.parquet` in always list → data.parquet externalized

3. **`externalize.min_size` threshold** (lowest priority)
   - If file size ≥ min_size (and no pattern match) → **Externalized**
   - Example: 5MB file with min_size=200kb → externalized

**Implementation Reference:** `packages/blobsy/src/compress.ts:30-46` (same logic
applies to compression)

**Pattern Matching:**

- Uses glob-style matching via `micromatch`
- Patterns match against **repository-relative paths** (forward slashes, even on
  Windows)
- Examples:
  - `*.pkl` matches `model.pkl` and `data/weights.pkl`
  - `data/**/*.bin` matches only `.bin` files under `data/` directory

**Subdirectory Config Behavior:**

Config files in subdirectories **replace** parent patterns (not append):

```yaml
# Root .blobsy.yml
externalize:
  always: ["*.parquet", "*.bin"]
  never: ["*.md"]

# data/experiments/.blobsy.yml
externalize:
  always: ["*.pkl"]  # Replaces root 'always' list
  never: []          # Replaces root 'never' list (empty = nothing ignored)
```

Result:
- `data/model.bin` → Uses root config → **Externalized** (matches *.bin in always)
- `data/experiments/weights.pkl` → Uses subdir config → **Externalized** (matches *.pkl
  in always)
- `data/experiments/model.bin` → Uses subdir config → **NOT externalized** (subdir
  config replaced *.bin)

**Best Practice:** Keep externalization rules in root `.blobsy.yml` to avoid confusion.
Use subdirectory configs only when absolutely necessary.

### Remote Storage Layouts

Blobsy uses **configurable key templates** to determine where blobs are stored in the
remote. The template is evaluated for each file to compute its remote key, which is then
stored in the `.bref` file.

**Full remote key structure:**
```
{bucket}/{global_prefix}/{evaluated_template}
```

The `global_prefix` is configured per backend (e.g., `project-alpha/`), and the template
is evaluated with variables like `{content_sha256}` and `{repo_path}`.

#### Template Variables

| Variable | Description | Example |
| --- | --- | --- |
| `{iso_date_secs}` | ISO timestamp with second resolution, punctuation-free | `20260220T140322Z` |
| `{content_sha256}` | Full SHA-256 hash (64 chars) | `7a3f0e9b2c1d4e5f...` |
| `{content_sha256_short}` | Short SHA-256 hash (12 chars) | `7a3f0e9b2c1d` |
| `{repo_path}` | Repository-relative path | `data/research/model.bin` |
| `{filename}` | Filename only | `model.bin` |
| `{dirname}` | Directory path only | `data/research/` |
| `{git_branch}` | Current git branch | `main`, `feature/x` |
| `{compress_suffix}` | Compression suffix based on algorithm | `.zst`, `.gz`, `.br`, or empty string |

**V1 Implementation Status:**
- ✅ Implemented: `{iso_date_secs}`, `{content_sha256}`, `{content_sha256_short}`,
  `{repo_path}`, `{filename}`, `{dirname}`, `{compress_suffix}`
- ⏸️ Deferred to V2: `{git_branch}` (see implementation rationale in
  [issues-history.md](issues-history.md#L101))

The `{git_branch}` variable and branch-isolated storage mode are fully designed for V2
but not implemented in V1. If you specify a template containing `{git_branch}` in V1,
`blobsy push` will issue a warning and leave the variable unexpanded (e.g.,
`{git_branch}/sha256/...` as a literal path).

Any text outside `{...}` is kept as-is (literal prefix/suffix).

**Note on `{content_sha256_short}`:** Uses the first 12 hex characters of SHA-256 (48
bits of entropy). Collision probability is negligible for typical use (birthday paradox:
~1% chance after ~2.4 million files, ~50% chance after ~17 million files).

**Note on `{iso_date_secs}`:** Format is `YYYYMMDDTHHMMSSZ` (e.g., `20260220T140322Z`).
All punctuation removed for cleaner keys.
Granularity is **1 second** (no sub-second precision).

**Deduplication and Collision Behavior:**

Same path + content + timestamp → **Deduplicates** (produces identical key)
- Example: Two users push identical `data/model.bin` at `20260220T140322Z`
- Key: `20260220T140322Z-7a3f0e9b2c1d/data/model.bin.zst` (both users)
- Result: Last write wins (S3 overwrites), but content is identical so no data loss

Same path + **different content** + same timestamp → **Different keys** (hash differs)
- Example: User A pushes `model_v1.bin`, User B pushes `model_v2.bin` at same second
- Key A: `20260220T140322Z-abc12345.../data/model.bin`
- Key B: `20260220T140322Z-def67890.../data/model.bin`
- Result: No collision, both versions stored

**Multi-User Safety:**

The default template provides collision safety even at second granularity because:
1. Content hash is part of the key → different content = different key
2. Identical content pushes deduplicate safely (overwriting identical blob is harmless)
3. Path is part of key → different paths never collide

**Timestamp Format Implementation:** See `template.ts:38-40` for `formatIsoDateSecs()`.

**Compression Suffix Handling:**

The `{compress_suffix}` variable is **automatically evaluated** based on the compression
decision made by `shouldCompress()` (see `compress.ts:30-46`). The suffix is determined
as follows:

1. **Compression Decision** (per file):
   - Check if file matches `compress.never` patterns → **No compression**, suffix = `''`
   - Check if file matches `compress.always` patterns → **Compress**, suffix based on
     algorithm
   - Check if file size ≥ `compress.min_size` → **Compress**, suffix based on algorithm
   - Otherwise → **No compression**, suffix = `''`

2. **Suffix Mapping** (see `template.ts:82-94`):
   ```
   zstd → '.zst'
   gzip → '.gz'
   brotli → '.br'
   no compression → ''
   ```

3. **Template Evaluation**:
   - If your template includes `{compress_suffix}`, it expands to the suffix (or empty
     string)
   - If your template omits `{compress_suffix}`, compressed and uncompressed versions
     **will collide** on the same remote key

**Best Practice:** Always include `{compress_suffix}` in custom templates to prevent
collisions.

**Default Behavior:** The default template
(`'{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}'`) includes the
suffix, so users don’t need to think about this unless they customize
`remote.key_template`.

**Example Collision Scenario:**
```yaml
# ❌ BAD: Custom template without compress_suffix
remote:
  key_template: '{content_sha256}/{repo_path}'

# Result: compressed and uncompressed versions collide
# - First push (uncompressed): key = sha256-abc123.../data/model.bin
# - Second push (now compressed): key = sha256-abc123.../data/model.bin ← Same key!
```

```yaml
# ✅ GOOD: Include compress_suffix
remote:
  key_template: '{content_sha256}/{repo_path}{compress_suffix}'

# Result: compressed and uncompressed versions have different keys
# - Uncompressed: sha256-abc123.../data/model.bin
# - Compressed: sha256-abc123.../data/model.bin.zst ← Different key
```

**Compression State Storage:** The actual compression algorithm and compressed size are
stored in the `.bref` file (fields `compressed` and `compressed_size`). The remote key
suffix is only a convenience for human readability.

**Note on path separators:** All path variables (`{repo_path}`, `{dirname}`) use POSIX
forward slashes (`/`) in remote keys, regardless of the local OS. On Windows,
backslashes in local paths are automatically converted to forward slashes when
constructing remote keys.
This ensures cross-platform compatibility and correct behavior with cloud storage
providers.

#### Common Layout Patterns

Blobsy supports three common patterns out of the box.
Each optimizes for different needs.

##### Pattern 1: Timestamp + Content Hash (Default - Recommended)

**Chronologically sortable with good deduplication.**

```yaml
# .blobsy.yml
backends:
  default:
    url: s3://my-datasets/project-alpha/
    region: us-east-1

remote:
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"  # default
```

**Example remote keys:**
```
s3://my-datasets/project-alpha/
  20260220T140322Z-7a3f0e9b2c1d/data/research/model.bin
  20260220T140322Z-b4c8d2a1e3f5/data/research/dataset.parquet.zst
  20260220T140425Z-a1b2c3d4e5f6/results/output.json.zst
  20260221T093015Z-7a3f0e9b2c1d/data/research/model.bin  # same content, next day = new key
```

**Properties:**
- ✅ **Chronologically sortable:** List by age, browse by time period
- ✅ **Path-browsable:** Can see file paths within each timestamp prefix
- ✅ **Batch deduplication:** Same file pushed in same second with same content = same
  key
- ✅ **Content verification:** Hash in key ensures integrity
- ✅ **Compression-aware:** `.zst` suffix distinguishes compressed from uncompressed
- ✅ **Intuitive:** Timestamp, hash, and path are all human-readable
- ⚠️ **Cross-time duplication:** Same content pushed at different times = different keys
- ⚠️ **Second-level granularity:** Files pushed in different seconds don’t dedupe

**Dedup characteristics:**
- Same file (same path + same content) pushed **within the same second** = deduplicates
- Common in build/dataset generation (batch of files created at once)
- Different times = different keys (trades off some dedup for chronological
  organization)

**Use when:** You want a balance of organization, deduplication, and age-based
management. **This is the recommended default** for most teams: intuitive, sortable,
enables time-based cleanup, and still deduplicates re-pushes of the same content to the
same path within the same second.

##### Pattern 2: Pure Content-Addressable (Maximum Dedup)

**Maximum deduplication across all branches, paths, and time.**

```yaml
# .blobsy.yml
remote:
  key_template: "sha256/{content_sha256}"
```

**Example remote keys:**
```
s3://my-datasets/project-alpha/
  sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
  sha256/b4c8d2a1e3f5b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6
  sha256/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

**Properties:**
- ✅ **Maximum dedup:** Same content anywhere (any path, any branch, any time) = single
  copy
- ✅ **Immutable:** Hash = identity, blobs never overwritten
- ✅ **Fast renames/moves:** No re-upload needed (hash doesn’t change)
- ✅ **Minimal storage:** Absolute minimum storage usage
- ✅ **No post-merge gap:** Feature branch blob = same key as main
- ❌ **Not chronologically sortable:** Can’t list by age
- ❌ **Not browsable:** Remote shows hashes, not paths or timestamps

**Use when:** Storage cost is the primary concern and you don’t need chronological
organization. Good for ML model versioning where the same model file appears in many
contexts.

##### Pattern 3: Branch-Isolated Storage (Deferred)

**Separate namespaces per branch, with dedup within each branch.**

**Note:** The `{git_branch}` template variable and branch-isolated storage are deferred
to a future version.
The initial release supports timestamp+hash (Pattern 1), pure CAS (Pattern 2), and
shared storage (Pattern 4) only.

```yaml
# .blobsy.yml
backends:
  default:
    url: s3://my-datasets/project-alpha/
    region: us-east-1

remote:
  key_template: "{git_branch}/sha256/{content_sha256}"
```

**Example remote keys:**
```
s3://my-datasets/project-alpha/
  main/
    sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
    sha256/b4c8d2a1e3f5b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6
  feature/new-model/
    sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
    sha256/c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
```

**Properties:**
- ✅ **Branch isolation:** Each branch has its own namespace
- ✅ **Dedup within branch:** Same content in same branch = one copy
- ✅ **Browse by branch:** Easy to see what’s on each branch
- ✅ **Safe experimentation:** Feature branches don’t clutter main’s storage
- ⚠️ **Cross-branch duplication:** Same content on different branches = duplicated
- ⚠️ **Post-merge cleanup:** After merging, feature branch blobs can be GC’d

**Post-merge behavior:** After `git merge feature/new-model` into `main`:
- Feature branch `.bref` files are now on main
- They still point to `feature/new-model/sha256/...` keys (stored in `.bref`)
- Those blobs remain accessible until GC runs
- Optional: Re-push on main to migrate blobs to `main/sha256/...` namespace

**Use when:** You want clear separation between branches, or are working with
experimental/temporary branches that should be cleanly removed.

**V2 Specification (Not Implemented in V1):**

**Error behavior (V2 specification):**

- **Detached HEAD:** If `{git_branch}` is used but the working tree is in detached HEAD
  state, `blobsy push` MUST fail with a clear error: `Error: Cannot resolve
  {git_branch}: HEAD is detached.
  Use a named branch or switch to a template without {git_branch}.` Rationale: pushing
  to a namespace derived from a commit hash would create un-discoverable, un-manageable
  blobs.
- **Unnamed branch:** Same error if HEAD points to a branch that has no name (orphan
  branch state).
- **Branch name sanitization:** The resolved branch name will be passed through
  `sanitizeKeyComponent()` (implemented in `template.ts:25-39`) which handles characters
  problematic for S3 keys.
  Forward slashes are **preserved** to create directory-like structure (e.g.,
  `feature/model-v2` → `feature/model-v2/sha256/...` in remote storage).

**Explicit cleanup semantics (V2 specification):**

- After `git merge feature/X` into `main`, the feature branch blobs remain accessible at
  their original `feature/X/sha256/...` keys (stored in each `.bref`’s `remote_key`).
- `blobsy gc --branch-cleanup feature/X` would:
  1. Verify no live `.bref` in any reachable branch references `feature/X/...` keys.
  2. List and delete all remote objects under the `feature/X/` prefix.
  3. Remove corresponding `.blobsy/trash/` entries.
- Without explicit cleanup, feature branch blobs persist indefinitely (safe default).
- `blobsy gc --dry-run --branch-cleanup feature/X` previews what would be deleted.

##### Pattern 4: Global Shared Backing Store

**Single flat namespace, last-write-wins semantics (like rsync or network drives).**

```yaml
# .blobsy.yml
backends:
  default:
    url: s3://my-datasets/project-alpha/
    region: us-east-1

remote:
  key_template: "shared/{repo_path}"
```

**Example remote keys:**
```
s3://my-datasets/project-alpha/
  shared/
    data/research/model.bin
    data/research/results.parquet
    data/raw/dataset.csv
```

**Properties:**
- ✅ **Path-browsable:** Remote mirrors local directory structure
- ✅ **Simple mental model:** What you see is what you get
- ✅ **Last-write-wins:** Latest push overwrites previous content
- ✅ **Works with external tools:** Any S3 tool can browse/download
- ❌ **No dedup:** Each file path is unique (ignores content)
- ❌ **No versioning:** Overwriting loses history
- ❌ **Renames require re-upload:** Path is the key
- ⚠️ **Concurrent pushes can conflict:** Two users pushing same path, last push wins

**Use when:** You want a simple synchronized directory, versioning is handled by git,
and you don’t need content dedup.
Good for teams familiar with rsync/network drive workflows.

**Warning:** This mode has no built-in conflict resolution.
If two users push different content to the same path, last push wins.
Use branch-isolated storage if multiple users push concurrently.

#### Comparison Table

|  | Timestamp+Hash (Default) | Pure CAS | Branch-Isolated | Global Shared |
| --- | --- | --- | --- | --- |
| **Template** | `{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}` | `sha256/{content_sha256}` | `{git_branch}/sha256/{content_sha256}` | `shared/{repo_path}` |
| **Dedup** | Same path+content+timestamp | Maximum (global) | Per-branch | None |
| **Browsability** | By time, then path | By hash only | By branch, then hash | By path |
| **Sortable by age** | Yes (chronological) | No | No | No |
| **Rename cost** | Re-upload | Free | Free | Re-upload |
| **Storage growth** | Low-moderate | Minimal | Moderate | High |
| **Age-based cleanup (Deferred)** | Easier (GC by date prefix) | Requires full scan | Requires full scan | Requires filtering |
| **Best for** | General use, balanced needs | Minimum storage cost | Multi-branch workflows | Simple sync, rsync-like |

#### Advanced: Custom Templates

You can combine template variables for custom layouts:

**Content-addressed with filename suffix for debugging:**
```yaml
key_template: "sha256/{content_sha256}---{filename}"
# Result: sha256/7a3f0e9b...---model.bin
# Still deduplicates, but easier to identify in S3 console
```

**Branch-isolated with paths:**
```yaml
key_template: "{git_branch}/{repo_path}"
# Result: main/data/model.bin
# Path-browsable per branch, no dedup
```

**Hybrid: content-addressed with branch prefix:**
```yaml
key_template: "{git_branch}/cas/{content_sha256}"
# Result: main/cas/7a3f0e9b...
# Dedup within branch, isolated across branches
```

#### How Templates Work

1. **On `blobsy track`:** Compute hash, create `.bref` with `hash` and `size` (no remote
   key yet)
2. **On `blobsy push`:**
   - Evaluate `key_template` for each file with current context (branch, path, hash,
     etc.)
   - Compute full key: `{bucket}/{prefix}/{evaluated_template}`
   - Upload to the computed key
   - Store the **actual evaluated key** in `.bref`’s `remote_key` field
   - User commits `.bref` to git
3. **On `blobsy pull`:**
   - Read `remote_key` from `.bref`
   - Fetch from that exact key
4. **On `blobsy gc`:**
   - Collect all `remote_key` values from all `.bref` files in all reachable
     branches/tags
   - List remote objects
   - Delete objects whose key isn’t in the referenced set

**Important:** The `key_template` must be consistent across all users (set in the
committed `.blobsy.yml`). If users have different templates, they’ll push to different
keys and break sync.

## Ref File Format

Every `.bref` file starts with a self-documenting comment header, followed by YAML. Ref
files use stable key ordering (keys are always written in the order shown below) to
minimize noise in `git diff`.

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.1
hash: sha256:7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_key: sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
```

Fields:

| Field | Type | Description |
| --- | --- | --- |
| `format` | string | Format version (`blobsy-bref/0.1`) |
| `hash` | string | Content identifier with `sha256:` prefix followed by 64-char lowercase hex hash of the original file content |
| `size` | integer | File size in bytes |
| `remote_key` | string | Evaluated template key where the blob is stored (relative to bucket and global prefix). Set by `blobsy push`. Empty or absent until first push. |

**Field types and encoding:**

- `hash`: Content identifier string in format `sha256:<64-char-hex>` (e.g.,
  `sha256:7a3f0e9b...`).
- `size`: integer, in bytes.
- `remote_key`: string, the evaluated template result (e.g., `sha256/7a3f0e...` or
  `main/sha256/7a3f0e...` or `shared/data/model.bin`).

**Format versioning:** The `format` field uses `<name>/<major>.<minor>` versioning
(e.g., `blobsy-bref/0.1`). Compatibility policy: reject if major version is unsupported;
warn if minor version is newer than the running blobsy version supports.

**Forward Compatibility Strategy:**

The `.bref` format is designed for forward compatibility across versions:

1. **Format version field** (`format: blobsy-bref/0.1`):
   - Major version changes (0.x → 1.x) indicate breaking changes
   - Minor version changes (0.1 → 0.2) indicate additive changes
   - V1 parser **allows** newer minor versions, **rejects** newer major versions

2. **Unknown field handling**:
   - V1 parser reads all fields as key-value pairs (YAML parsing)
   - Unknown fields are **ignored** during validation (defensive parsing)
   - Known fields are validated, unknown fields pass through

3. **Field ordering is stable**:
   - Fields always written in same order to minimize git diff noise
   - New fields in V2 will be appended after existing fields

**Example: V1 Parser Reading V2 .bref**

V2 `.bref` with `remote_checksum` field:
```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.2
hash: sha256:7a3f0e...
size: 15728640
remote_key: sha256/7a3f0e...
compressed: zstd
compressed_size: 8421376
remote_checksum: etag:d41d8cd98f00b204e9800998ecf8427e  # V2 field
```

V1 parser behavior:
- Reads `format: blobsy-bref/0.2` → **Accepts** (minor version bump)
- Validates required fields: `hash`, `size` → ✅ Present and valid
- Reads `remote_checksum` field → **Ignores** (unknown field)
- Result: Successfully reads `.bref`, ignores V2-specific field

**Implementation:** `packages/blobsy/src/ref.ts:89-117` (validateFormatVersion function)

**Reserved Field Ordering (V2 Proposal):**

Future `.bref` fields will follow this order:
```yaml
format: ...
hash: ...
size: ...
remote_key: ...
compressed: ...
compressed_size: ...
remote_checksum: ...      # V2: Provider ETag/checksum (e.g., "etag:d41d8cd98f...")
last_verified: ...        # V2: Timestamp of last integrity check
```

This ordering ensures V1 and V2 `.bref` files have minimal diff noise.

**Why `remote_key` is in the ref:** Pull needs to know exactly where to find the blob.
Storing the evaluated key in the ref means git versions it, and anyone who checks out
the ref can pull without needing to re-evaluate the template or know what template was
used. Push evaluates the template and sets this field; it’s empty (or absent) until the
first push.

**Important:** The `remote_key` is the evaluated template result, NOT including the
bucket or global prefix.
Full remote path is constructed as: `{bucket}/{global_prefix}/{remote_key}`.

**Why no `updated` timestamp:** Git already tracks when the file changed (`git log`). A
timestamp in the ref adds no information and creates meaningless diffs.

### Ref with Compression

When a file is compressed before upload, the `.bref` records this:

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.1
hash: sha256:7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_key: sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
compressed: zstd
compressed_size: 4194304
```

The hash is always of the original file -- this ensures `blobsy status` can verify
integrity by hashing the local file without decompressing anything.

**Compression and remote keys:** If compression affects the stored object (which it
typically does), the compression suffix should be part of the template to avoid key
collisions:
```yaml
# With compression suffix in template
key_template: "sha256/{content_sha256}.zst"  # when compressed: zstd is enabled
# Result: remote_key: sha256/7a3f0e...zst
```

Alternatively, compression state is recorded in the `.bref` and blobsy handles the
suffix automatically when constructing the final remote key during upload/download.

## File State Model

Every tracked file has three independent states that determine what actions are needed.
Blobsy uses a clear symbol system to show these states at a glance.

### Three Orthogonal States

For every tracked file:

1. **Tracked:** Does a `.bref` file exist in the working tree?
2. **Synced:** Does the remote blob exist (indicated by `remote_key` being set)?
3. **Committed:** Is the `.bref` file committed to git HEAD?

These three states are independent - a file can be synced but not committed, committed
but not synced, etc.

### State Symbols

| Symbol | Committed | Synced | Meaning | Next Action |
| --- | --- | --- | --- | --- |
| `○` | ✗ | ✗ | Just tracked, needs push and commit | `blobsy push` + `git commit` |
| `◐` | ✓ | ✗ | Committed but not uploaded | `blobsy push` |
| `◑` | ✗ | ✓ | Uploaded but not committed | `git commit` |
| `✓` | ✓ | ✓ | Fully done | None |
| `~` | - | - | Modified locally (hash changed) | `blobsy track` |
| `?` | - | - | Missing local file | `blobsy pull` or `blobsy rm` |
| `⊗` | - | - | Staged for deletion | `git commit` |

**Note on `~` and `?`:** These indicate the local file state, independent of commit/sync
status.

### State Detection

**Tracked:** `.bref` file exists in working tree.

**Synced:**
- `.bref` has `remote_key` field set (not empty)
- Optionally verified: remote blob actually exists at that key

**Committed:**
```bash
# Compare working tree .bref to HEAD
git show HEAD:path/to/file.bref 2>/dev/null | diff - path/to/file.bref
# No diff = committed, diff = not committed
```

**Modified:** Local file hash ≠ `.bref` hash field.

**Missing:** `.bref` exists but local file doesn’t exist.

**Staged for deletion:** `.bref` in `.blobsy/trash/`, not in working tree.

### Example Status Output

```bash
$ blobsy status

Tracked files (7):
  ✓ data/model-v1.bin (committed and synced)
  ○ data/model-v2.bin (not committed, not synced)
  ◐ data/dataset.parquet (committed, not synced)
  ◑ results/output.json (not committed, synced)
  ~ data/experiment.bin (modified locally)
  ? data/missing.bin (file missing)
  ⊗ data/old.bin (staged for deletion)

Summary:
  1 fully synced (✓)
  1 needs push (◐)
  2 need commit (○ ◑)
  1 modified (~)
  1 missing (?)
  1 staged for deletion (⊗)

Actions needed:
  Run 'blobsy track data/experiment.bin' to update modified file
  Run 'blobsy push' to sync 1 file (◐)
  Run 'blobsy pull data/missing.bin' or 'blobsy rm data/missing.bin'
  Run 'git add -A && git commit' to commit 2 refs and finalize deletion
```

**Uncommitted .bref Handling Details:**

When `blobsy sync` encounters uncommitted `.bref` files, the behavior follows this
decision flow:

1. **Check working tree state** → Compare working tree `.bref` to `HEAD:.bref`
2. **Issue warning** if uncommitted refs detected:
   ```
   Warning: 2 .bref files have uncommitted changes.
   Run 'git add -A && git commit' to commit them.
   ```
3. **Proceed to stat cache merge** → Use three-way merge algorithm (see
   [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md#three-way-merge-algorithm))
4. **Error if ambiguous** → No merge base exists (see line 356-368 of
   stat-cache-design.md):
   ```
   Error: No stat cache entry for data/model.bin.
   Cannot distinguish local edit from git pull.
   Use 'blobsy push' or 'blobsy pull' explicitly.
   ```

**Precedence:** Warning is shown first, but ambiguous state can still cause error.
Sync proceeds only if stat cache state is **unambiguous**.

**Example: Uncommitted + Ambiguous**
```bash
$ blobsy sync
Warning: 1 .bref file has uncommitted changes. Run 'git add -A && git commit' to commit.

Syncing 1 file...
✗ Error: No stat cache entry for data/model.bin.
Cannot distinguish local edit from git pull.
Use 'blobsy push' or 'blobsy pull' explicitly.
```

**Recovery Flow:**
1. User runs `blobsy status` to see current state
2. User decides: `blobsy push` (if local changes intended) or `blobsy pull` (if git pull
   updated ref)
3. After explicit push/pull, stat cache is updated with merge base
4. Future `blobsy sync` will work without ambiguity

### State Transitions

**Typical workflow:**

```bash
# 1. Track a file
$ blobsy track data/model.bin
○ data/model.bin (not committed, not synced)

# 2. Push to remote
$ blobsy push data/model.bin
◑ data/model.bin (not committed, synced)

# 3. Commit the ref
$ git add data/model.bin.bref && git commit -m "Track model"
✓ data/model.bin (committed and synced)
```

**Alternative workflow (commit first):**

```bash
# 1. Track
$ blobsy track data/model.bin
○ data/model.bin (not committed, not synced)

# 2. Commit first
$ git add data/model.bin.bref && git commit -m "Track model"
◐ data/model.bin (committed, not synced)

# 3. Push (updates remote_key in working tree)
$ blobsy push
◑ data/model.bin (not committed, synced)
Note: Updated remote_key in 1 .bref file

# 4. Commit the remote_key update
$ git commit -am "Update remote_key after push"
✓ data/model.bin (committed and synced)
```

### Working Tree vs HEAD Semantics

Different commands read from different git states:

| Command | Reads .bref from | Can operate on uncommitted refs? | Modifies .bref? |
| --- | --- | --- | --- |
| `blobsy track` | Working tree | Yes | Yes (updates hash/size) |
| `blobsy push` | Working tree | Yes (with warning) | Yes (sets remote_key) |
| `blobsy pull` | Working tree | Yes (with warning) | No |
| `blobsy sync` | Working tree | Yes (with warning) | Yes (sets remote_key if pushing) |
| `blobsy status` | Both (working tree + HEAD) | Yes | No |
| `blobsy verify` | Working tree | Yes | No |
| `blobsy gc` (Deferred) | HEAD (all branches/tags) | N/A | No |

**Key principle:** Commands read from **working tree** for current state, compare to
**HEAD** to determine if committed.

**GC is special (Deferred):** It reads from HEAD across all branches/tags to determine
which remote blobs are referenced.

### Warnings for Uncommitted Refs

Commands that modify `.bref` files warn when they’re uncommitted:

```bash
$ blobsy push
Warning: Operating on 2 uncommitted .bref files:
  data/model.bin.bref (new)
  results/output.json.bref (modified)

Uploading 2 files...
  ◑ data/model.bin (500 MB)
  ◑ results/output.json (1.2 MB)

Reminder: Run 'git add -A && git commit' to commit these refs.
```

### Error States (Inline Warnings)

Rare error conditions are shown as inline warnings, not special symbols:

```bash
$ blobsy status data/corrupt.bin
◐ data/corrupt.bin (committed, not synced)
   ⚠ Warning: remote_key references missing blob
      Referenced: 20260220T140322Z-abc123/data/corrupt.bin
      Remote blob not found
      Run 'blobsy push' to re-upload

$ blobsy verify
✓ data/model.bin (ok)
~ data/experiment.bin (modified)
◐ data/corrupt.bin (committed, not synced)
   ⚠ Hash mismatch (possible corruption):
      Expected: abc123...
      Actual:   def456...
      Run 'blobsy track' to update ref, or 'blobsy pull --force' to re-download
```

## Integrity Model

### Three Integrity Layers

| Layer | Question | Who handles it? |
| --- | --- | --- |
| **Transfer integrity** | Did the bytes arrive intact? | Transport tools (S3 ETags, Content-MD5, rclone checksums) |
| **Change detection** | Has this file changed since last sync? | SHA-256 hash in `.bref` vs local file hash |
| **At-rest verification** | Does this local file match what was pushed? | SHA-256 in `.bref` (`blobsy verify`) |

**Transfer integrity** is handled by the transport layer.
S3 verifies uploads via ETags and supports `x-amz-checksum-sha256` natively.
`aws s3 sync` and `rclone` verify transfers internally.
Blobsy does not re-implement transfer verification.

**Change detection** uses SHA-256 hashes in the `.bref` file.
Every tracked file has its hash in its own `.bref`. This enables accurate change
detection independent of mtime (which `git checkout` doesn’t preserve), and clear signal
in `git diff` when data actually changed.

**At-rest verification** via `blobsy verify`: hash each local file, compare against the
`.bref`’s `hash`, report mismatches.
Works for all tracked files, fully offline.

### Why SHA-256 Over Provider-Native Hashes

Cloud storage providers each compute their own checksums, but the landscape is too
fragmented to rely on.
AWS S3 auto-computes CRC64NVME, GCS uses CRC32C, Azure uses MD5 (only for small
uploads), Backblaze uses SHA-1, and R2/Wasabi/Tigris use MD5 ETags for non-multipart
uploads only. Multipart uploads produce composite checksums on most providers that don’t
match a simple hash of the whole file.

Computing SHA-256 independently and storing it in `.bref` files is the only portable
approach that works consistently across all providers.

When using the built-in SDK, blobsy can provide `x-amz-checksum-sha256` with the upload
and S3 verifies server-side -- but this uses the same SHA-256 blobsy already computes,
not an additional algorithm.

**V2: Remote Checksum Support (Deferred).** A future version may store provider-native
checksums (ETags, CRC32C, etc.)
in `.bref` files as an optional `remote_checksum` field.
This would enable fast remote verification (`blobsy verify --remote`) without
downloading the file -- just compare the stored checksum against the provider’s current
metadata. Design constraints:
- The field is informational and provider-specific; it cannot replace SHA-256 for
  cross-provider portability.
- Multipart upload ETags are composite and provider-specific; only single-part upload
  checksums are usable for verification.
- The backend interface would gain an optional
  `getChecksum(remoteKey): Promise<string | undefined>` method.
- Provider checksum is captured at push time and stored alongside `remote_key`.

### Why Hashing Is Essentially Free

On `blobsy push`, blobsy already reads each file to upload it.
Computing SHA-256 during that read adds negligible overhead:

- SHA-256 throughput: ~400-600 MB/s on modern hardware
- A directory with 1,000 files totaling 1 GB: ~2 seconds of hashing
- The upload itself takes orders of magnitude longer

When using the built-in `@aws-sdk` fallback, hashes are computed during the upload read
(single I/O pass). When delegating to external tools (aws-cli, rclone, or template
commands), hashing requires a separate read pass -- the file is read once to hash, then
the external tool reads it again to transfer.
In practice the OS page cache makes the second read nearly free.

### Local Stat Cache

Blobsy maintains a local stat cache (gitignored, machine-local) that stores the
last-known state of each tracked file.
The stat cache serves two purposes:

1. **Performance** -- Avoid re-hashing unchanged files by checking `size` + `mtimeNs`
   first.
2. **Correctness** -- Provide the merge base for three-way conflict detection during
   sync (distinguishes “git pull updated .bref” from “user modified file”).

The stat cache is **mandatory** for operations that modify `.bref` files (`track`,
`push`, `pull`, `sync`) and optional for read-only operations (`status`, `verify`).

Uses file-per-entry storage (one JSON file per tracked file) with atomic writes to
eliminate concurrent-write conflicts between parallel blobsy processes.

See [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md) for full design: entry
format, storage layout, API, three-way merge algorithm, cache update rules, and
recovery.

### Future: Remote Staleness Detection via Provider Hashes

One optimization for a future version: after a successful push, blobsy could store the
provider’s response hash (e.g., ETag, `x-amz-checksum-crc64nvme`) alongside the
`remote_key` in the `.bref`. This enables cheap remote staleness detection: a
`HeadObject` request returns the current provider hash, and if it matches the stored
value, the remote file hasn’t changed since last push -- without downloading or
re-hashing.

This is not needed for the initial release -- SHA-256 hashes in `.bref` files handle all
verification needs.

## CLI Commands

### Path Specifications

All blobsy commands that operate on files accept flexible path specifications:

**Accepted path formats:**

1. **Original file path:** `data/model.bin`
2. **Ref file path:** `data/model.bin.bref` (equivalent to #1)
3. **Directory path:** `data/research/` (behavior depends on command)

**Path resolution:**

- When you specify `data/model.bin.bref`, blobsy treats it as `data/model.bin`
- Both forms are accepted and produce identical results
- This allows tab-completion to work naturally (completing to `.bref` files works)

**Directory behavior by command:**

| Command | Directory Support | Recursive by Default | Notes |
| --- | --- | --- | --- |
| `blobsy track` | Yes | Yes | Applies externalization rules per-file |
| `blobsy untrack` | Yes | Requires `--recursive` | Safety: prevents accidental bulk untrack |
| `blobsy rm` | Yes | Requires `--recursive` | Safety: prevents accidental bulk deletion |
| `blobsy push` | Yes | Yes | Uploads all tracked files in directory |
| `blobsy pull` | Yes | Yes | Downloads all tracked files in directory |
| `blobsy sync` | Yes | Yes | Syncs all tracked files in directory |
| `blobsy status` | Yes | Yes | Shows status of all tracked files in directory |
| `blobsy verify` | Yes | Yes | Verifies all tracked files in directory |

**Examples:**

```bash
# These are equivalent (file path vs .bref path)
blobsy track data/model.bin
blobsy track data/model.bin.bref

# Directory operations
blobsy track data/research/              # Tracks all eligible files (recursive)
blobsy status data/research/              # Shows status of tracked files in directory
blobsy untrack --recursive data/old/      # Requires --recursive flag
blobsy rm --recursive data/experiments/   # Requires --recursive flag

# Path omitted = operate on entire repo
blobsy status        # All tracked files in repo
blobsy sync          # All tracked files in repo
```

**No glob patterns in the initial release:**

Glob expansion (e.g., `data/*.bin`) is handled by your shell, not by blobsy.
Use shell globs or pass explicit paths.

```bash
# Shell expands the glob
blobsy track data/*.bin

# Or use find
find data -name "*.bin" -exec blobsy track {} +
```

### `blobsy setup` (recommended)

Set up blobsy in a git repo.
Wraps `init` with agent integration: creates `.blobsy.yml`, installs git hooks, and
installs agent integration files (`.claude/skills/blobsy/SKILL.md` if Claude Code is
detected, `AGENTS.md` section if the file exists).
Idempotent -- safe to re-run.

```bash
blobsy setup --auto s3://my-datasets/project-v1/ --region us-east-1
blobsy setup --auto local:../blobsy-remote
```

### `blobsy init`

Low-level initialization (prefer `blobsy setup --auto`). Initialize blobsy in a git
repo. Idempotent — every developer runs this after cloning.

Fully non-interactive.
Backend is specified as a URL (positional argument).
Fails with a helpful error if required arguments are missing (never prompts).

**First run (no config exists):** Creates `.blobsy.yml` and installs the pre-commit
hook.

```bash
# S3 backend
$ blobsy init s3://my-datasets/project-v1/ --region us-east-1
Created .blobsy.yml
Installed pre-commit hook

# S3-compatible (R2)
$ blobsy init s3://my-r2-data/project/ --endpoint https://ACCT_ID.r2.cloudflarestorage.com
Created .blobsy.yml
Installed pre-commit hook

# Local backend (for dev/testing)
$ blobsy init local:../blobsy-remote
Created .blobsy.yml
Installed pre-commit hook
```

**Subsequent runs (config already exists):** Skips config setup, installs hooks only.

```bash
$ blobsy init
Found existing .blobsy.yml -- skipping config setup
Installed pre-commit hook
```

**Arguments and flags:**

| Argument/Flag | Required | Description |
| --- | --- | --- |
| `<url>` | Yes (first run) | Backend URL: `s3://bucket/prefix/`, `gs://bucket/prefix/`, or `local:path` |
| `--region <region>` | For `s3` | AWS region (or S3-compatible region) |
| `--endpoint <url>` | For S3-compatible | Custom endpoint URL (R2, MinIO, etc.) |

The URL scheme determines the backend type (`s3://` -> s3, `gs://` -> gcs, `azure://` ->
azure, `local:` -> local).
Bucket/prefix or directory path are parsed from the URL. Cloud schemes require a prefix.
See
[Backend URL Convention](blobsy-backend-and-transport-design.md#backend-url-convention)
for full parsing rules and validation.

On first run without a URL, `blobsy init` prints a usage error with examples (not a
prompt). On subsequent runs, the URL is optional -- the existing config is used.

**Relative paths** in `local:` URLs (e.g., `local:../blobsy-remote`) are always relative
to the git repo root, not the current working directory.
This matches the convention Git uses for `.gitignore` and submodule paths.
See
[Backend URL Convention](blobsy-backend-and-transport-design.md#backend-url-convention)
for details.

Also installs two git hooks: a pre-commit hook that validates `.bref` hashes, and a
pre-push hook that auto-uploads blobs before git refs are pushed.
See `blobsy hooks` below.

### `blobsy track`

Start tracking a file or directory with blobsy.

```bash
# Single file -- always externalizes, regardless of size rules
$ blobsy track data/bigfile.zip
Tracking data/bigfile.zip
Created data/bigfile.zip.bref
Added data/bigfile.zip to .gitignore

# Directory -- applies externalization rules to decide per-file
$ blobsy track data/research/
Scanning data/research/...
  data/research/report.md          (12 KB, .md)    -> kept in git
  data/research/config.yaml        (800 B, .yaml)  -> kept in git
  data/research/model.bin          (500 MB, .bin)   -> externalized (.bref)
  data/research/raw/metadata.txt   (500 B, .txt)   -> kept in git
  data/research/raw/data.parquet   (50 MB, .parquet) -> externalized (.bref)
2 files tracked, 3 kept in git.
```

**Key distinction:**

- **Explicit file** (`blobsy track data/bigfile.zip`): always externalizes.
  You named the file -- that’s explicit intent.
- **Directory** (`blobsy track data/research/`): applies the `externalize` rules from
  `.blobsy.yml` (size threshold, always/never patterns) to decide per-file.

What it does:

1. For each file to externalize: compute SHA-256, create a `.bref` adjacent to the file,
   add the original file to `.gitignore`.
2. For directories: skip files that don’t meet the externalization rules (they stay in
   git as normal files).
3. Skip files matching `ignore` patterns.

The `.bref` files are not yet git committed.
The user does that:

```bash
$ git add data/bigfile.zip.bref
$ git commit -m "Track bigfile with blobsy"
```

`blobsy track` is idempotent.
Running it on an already-tracked file updates the hash if the file changed, or does
nothing if unchanged.
This makes it the single command for both “start tracking” and “update after
modification”:

```bash
# After modifying a tracked file
$ blobsy track data/research/model.bin
Updated data/research/model.bin.bref (hash changed)

# Or refresh all tracked files in a directory
$ blobsy track data/research/
Updated data/research/model.bin.bref (hash changed)
1 file updated, 1 unchanged.
```

### `blobsy untrack`

Stop tracking a file or directory (keeps local file).

```bash
$ blobsy untrack data/bigfile.zip
Untracked data/bigfile.zip
Moved data/bigfile.zip.bref -> .blobsy/trash/data/bigfile.zip.bref
Removed data/bigfile.zip from .gitignore
(Local file preserved)
```

**Directory untracking (requires `--recursive`):**

```bash
$ blobsy untrack --recursive data/research/
Untracked 2 files in data/research/
Moved data/research/model.bin.bref -> .blobsy/trash/data/research/model.bin.bref
Moved data/research/raw/data.parquet.bref -> .blobsy/trash/data/research/raw/data.parquet.bref
Removed 2 entries from .gitignore
(Local files preserved)
```

**Path specifications:**

Both the original file path and `.bref` path are accepted:

```bash
blobsy untrack data/model.bin        # Works
blobsy untrack data/model.bin.bref   # Also works (same result)
```

**What it does:**

1. Move each `.bref` to `.blobsy/trash/` (preserving the path structure).
2. Remove the gitignore entry.
3. Leave local files and remote blobs untouched.

**Flags:**

| Flag | Effect |
| --- | --- |
| `--recursive` | Required for directory removal |

The user then `git add` + `git commit` to finalize.
The trash gives `blobsy gc` (Deferred) a record of which remote blobs were once
referenced.

### `blobsy rm`

Remove files from blobsy tracking and delete the local file.

**Default behavior (deletes local file):**

```bash
$ blobsy rm data/old-model.bin
⊗ data/old-model.bin (staged for deletion)

Moved data/old-model.bin.bref -> .blobsy/trash/data/old-model.bin.bref
Removed data/old-model.bin from .gitignore
Deleted local file: data/old-model.bin (500 MB freed)

Next: Run 'git add -A && git commit -m "Remove old-model.bin"'
```

**With `--local` flag (delete local file only, keep .bref and remote):**

```bash
$ blobsy rm --local data/large-dataset.parquet
? data/large-dataset.parquet (file missing)

Deleted local file: data/large-dataset.parquet (2.5 GB freed)
Kept .bref and remote blob (run 'blobsy pull' to restore)

Use case: Free up local disk space while keeping the file tracked and synced.
```

**Directory removal (requires `--recursive`):**

```bash
$ blobsy rm --recursive data/old-experiments/
Staged for removal (3 files):
  ⊗ data/old-experiments/model-v1.bin
  ⊗ data/old-experiments/model-v2.bin
  ⊗ data/old-experiments/results.csv

Moved 3 .bref files to .blobsy/trash/
Removed 3 entries from .gitignore
Deleted 3 local files (1.2 GB freed)
```

**Path specifications:**

Both the original file path and `.bref` path are accepted:

```bash
blobsy rm data/model.bin        # Works
blobsy rm data/model.bin.bref   # Also works (same result)
```

**Flags:**

| Flag | Effect |
| --- | --- |
| (none) | Move .bref to trash, remove from .gitignore, delete local file |
| `--local` | Delete local file only, keep .bref and remote blob (useful for freeing disk space) |
| `--recursive` | Required for directory removal |

**What it does:**

1. Default: Move `.bref` to `.blobsy/trash/`, remove from `.gitignore`, delete local
   file
2. `--local`: Only delete local file (keep tracking and remote)
3. Remote blobs always left untouched (GC removes them later, see deferred features)

**Difference from `blobsy untrack`:**
- `blobsy rm`: Deletes local file + stops tracking (permanent removal)
- `blobsy untrack`: Stops tracking, keeps local file (you want to manage it yourself)

**Note on trash command (Deferred):** The `blobsy trash` command (as a safer alternative
to `rm` that moves files to a trash directory before deletion) is deferred to a future
version. The initial release only provides `blobsy rm` for removing tracked files.

### `blobsy mv`

Rename or move a tracked file.
This fixes a critical gap: `git mv` only moves the `.bref` but leaves the payload at the
old location, causing constant drift.

**current behavior (files only):**

```bash
$ blobsy mv data/model-v1.bin data/model-v2.bin
Moved: data/model-v1.bin → data/model-v2.bin
Moved: data/model-v1.bin.bref → data/model-v2.bin.bref
Updated .gitignore (removed old entry, added new entry)

Next: Run 'git add -A && git commit -m "Rename model"'
```

**Path specifications:**

Both the original file path and `.bref` path are accepted:

```bash
blobsy mv data/old.bin data/new.bin        # Works
blobsy mv data/old.bin.bref data/new.bin   # Also works (same result)
```

**What it does:**

1. Verify source is tracked (has `.bref`)
2. Verify dest doesn’t already exist (neither file nor `.bref`)
3. Move local payload: `source → dest`
4. Move ref file: `source.bref → dest.bref`
5. Update `.gitignore` (remove source entry, add dest entry)
6. Preserve `remote_key` in the `.bref` (no re-upload needed)

**Key design decision:** The initial release always preserves the `remote_key`.
Rationale:

- Content hasn’t changed → no need to re-upload
- Avoids orphaning blobs at old keys
- Simpler implementation
- Works correctly for pure content-addressable templates
- For path-based templates, the old path is “frozen” in the remote key (acceptable
  tradeoff for the initial release)

**Multi-user workflow:**

```bash
# User A renames a file
$ blobsy mv data/model-v1.bin data/model-v2.bin
$ git add -A
$ git commit -m "Rename model-v1 to model-v2"
$ git push

# User B pulls the changes
$ git pull
# .bref renamed but payload still at old location

$ blobsy status
⚠ data/model-v2.bin.bref points to missing file
  Expected: data/model-v2.bin
  Found: data/model-v1.bin (at old location)
  Run: blobsy mv data/model-v1.bin data/model-v2.bin

$ blobsy mv data/model-v1.bin data/model-v2.bin
# Now in sync
```

### Directory-Spanning Moves

**Scenario:** Moving a tracked file from one directory to another.

**Example:**
```bash
blobsy mv data/old/model.bin research/experiments/model.bin
```

**Operation Sequence:**

1. **Validation:**
   - Check source file exists and is tracked (has `.bref`)
   - Check destination directory exists (create if `--mkdir` flag provided, error
     otherwise)
   - Check destination file doesn’t exist (error if exists, unless `--force`)

2. **Externalization Re-Evaluation:**
   - Read `.blobsy.yml` from destination directory context
   - Check if file still matches externalization rules in new location
   - **If destination has different externalization config**, issue warning:
     ```
     Warning: Destination directory has different externalization rules.
     File will remain externalized per source rules. Re-track with 'blobsy track' to re-evaluate.
     ```

3. **Move Operations:**
   - Move payload file: `data/old/model.bin` → `research/experiments/model.bin`
   - Move `.bref` file: `data/old/model.bin.bref` →
     `research/experiments/model.bin.bref`
   - Update `.bref` remote_key is **NOT changed** (remote blob stays at same key)

4. **Gitignore Updates:**
   - **Source directory** (`data/old/.gitignore`):
     - Remove `model.bin` entry from blobsy-managed block
     - If block becomes empty, remove the entire block
     - If `.gitignore` becomes empty, delete the file
   - **Destination directory** (`research/experiments/.gitignore`):
     - Add `model.bin` entry to blobsy-managed block
     - Create block if it doesn’t exist
     - Create `.gitignore` if it doesn’t exist

5. **Git Staging:**
   - Stage all modified files: payload, `.bref`, source `.gitignore`, dest `.gitignore`
   - User must commit the move

**Example Output:**
```bash
$ blobsy mv data/old/model.bin research/experiments/model.bin

✓ Moved data/old/model.bin → research/experiments/model.bin
✓ Moved data/old/model.bin.bref → research/experiments/model.bin.bref
✓ Updated .gitignore (2 files)

Staged files:
  research/experiments/model.bin
  research/experiments/model.bin.bref
  research/experiments/.gitignore
  data/old/.gitignore

Run 'git commit' to complete the move.
```

**Edge Case: Source .gitignore Cleanup**

If the moved file was the last entry in the source directory’s blobsy-managed block:

```gitignore
# Before move (data/old/.gitignore)
# blobsy -- DO NOT EDIT BELOW THIS LINE
model.bin
# blobsy -- DO NOT EDIT ABOVE THIS LINE

other-pattern.txt
```

```gitignore
# After move (data/old/.gitignore) -- blobsy block removed
other-pattern.txt
```

If the file becomes empty, it’s deleted.

**Current limitations (deferred to a future version):**

- No directory moves (only individual files)
- No `--new-key` flag (always preserves `remote_key`)
- No automatic move detection on `blobsy pull`

**Deferred enhancements:**

| Feature | Description |
| --- | --- |
| `blobsy mv --new-key` | Regenerate `remote_key` based on new path (requires re-upload) |
| `blobsy mv dir1/ dir2/` | Recursive directory moves (implemented on top of the initial release’s file move) |
| Auto-detection | `blobsy pull` detects moved `.bref` files and fixes payload paths automatically |

### `blobsy sync`

The primary sync command.
Ensures local files and remote blobs are in sync, automatically tracking changes and
syncing in both directions.

```bash
$ blobsy sync
Syncing 4 tracked files...
  ✓ data/bigfile.zip (committed and synced)
  ◑ data/research/report.md (not committed, synced) - pushed 4 KB
  ✓ data/research/raw/response.json (committed and synced) - pulled 1.0 MB
  ○ data/research/raw/data.parquet (not committed, not synced)

Done: 1 pushed, 1 pulled, 2 up to date

Reminder: 2 .bref files have uncommitted changes. Run 'git add -A && git commit' to commit.
```

**Reads from:** Working tree `.bref` files (can operate on uncommitted refs with
warnings).

**Algorithm:**

1. **Health check** (first, before processing any files):
   - Verify backend is accessible and credentials are valid
   - Fail fast with clear error if backend is unreachable
   - Skip with `--skip-health-check` flag (advanced use)
   - See
     [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md#health-check)

2. **For each `.bref` file**, apply the three-way merge algorithm using the stat cache
   as merge base. See [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md) for the
   full decision table and per-file sync logic.

   Summary:
   - **Local matches cache, .bref matches cache** -- up to date
   - **Local matches cache, .bref differs** -- git pull updated .bref, pull new blob
   - **Local differs from cache, .bref matches cache** -- user modified file, push
   - **Both differ** -- conflict, error with resolution options
   - **Local file missing** -- pull from remote (or error if remote also missing)

**Important:** Sync can modify `.bref` files (update hash, set `remote_key`). These
modifications are in the working tree - user must commit them.

**Transfer mechanics:**

Each file is an independent transfer.
Blobsy sync issues one CLI invocation per file, running up to `sync.parallel` (default:
8\) concurrently:

```
                       +-- aws s3 cp data/file1 s3://...
blobsy sync -----------+-- aws s3 cp data/file2 s3://...
  (orchestrator)       +-- aws s3 cp data/file3 s3://...
                       +-- ... (up to sync.parallel)
```

This is simple and works well for typical workloads (tens to hundreds of files).
The transfer tool (`aws-cli`, `rclone`, or a template command) handles each individual
upload/download.

### `blobsy push` / `blobsy pull`

Convenience aliases for one-directional sync:

```bash
$ blobsy push [path...]    # only upload, skip downloads
$ blobsy pull [path...]    # only download, skip uploads
```

Same precondition (refs must be committed).
Same per-file logic, just filtered to one direction.

**Push sanity check:** Before uploading, `blobsy push` verifies the local file’s hash
matches the `.bref` hash.
If the file was modified after `blobsy track`, the push fails with a helpful error.
Use `--force` to override (updates `.bref` to match current file, then pushes).

**Pull behavior on local modifications:** If a local file has been modified (hash
differs from both ref and remote), pull fails with exit code 2. Use `--force` to
overwrite local modifications.

Pull does not delete local files.
Extra local files not referenced by any `.bref` are left untouched.

### `blobsy status`

Show the state of all tracked files.
**Fully offline.**

```bash
$ blobsy status
  ✓  data/bigfile.zip  synced (500 MB)
  ~  data/research/report.md  modified (12 KB)
  ?  data/research/raw/resp.json  file missing (1.2 MB)
  ○  data/research/raw/data.parq  not pushed (45 MB)

4 tracked files: 1 synced, 1 modified, 1 missing_file, 1 new
```

What it does:

1. Find all `.bref` files in the repo.
2. For each, compare local file hash against the ref’s `hash`.
3. Display file sizes from `.bref` metadata and a per-state summary footer.
4. Report: ok, modified, missing, not pushed (no `remote_key`).
5. Show human-readable file sizes from `.bref` metadata.

No network access. The ref file has everything needed.

**Deferred enhancement:** File sizes shown in human-readable format (KB, MB, GB) for all
tracked files. Sizes are read from `.bref` metadata, so this remains fully offline.

### `blobsy stats`

Show aggregate statistics across all tracked files.
**Fully offline.**

```bash
$ blobsy stats

Repository: /Users/alice/projects/ml-research
Backend: s3://my-datasets/ml-research/

Tracked files by status:
  ✓ Fully synced (committed + uploaded):        8 files    (2.1 GB)
  ○ Not committed, not synced:                  2 files    (500 MB)
  ◐ Committed, not synced:                      3 files    (1.2 GB)
  ◑ Not committed, synced:                      1 file     (45 MB)
  ~ Modified locally:                           2 files    (850 MB)
  ? Missing locally:                            1 file     (120 MB)
  ⊗ Staged for deletion:                        1 file     (300 MB)
  ────────────────────────────────────────────────────────────────
  Total tracked:                                18 files   (5.1 GB)

Actions needed:
  Run 'blobsy track' to update 2 modified files
  Run 'blobsy push' to sync 3 files (1.2 GB)
  Run 'blobsy pull' to restore 1 missing file (120 MB)
  Run 'git add -A && git commit' to commit 3 refs and finalize deletion
```

What it does:

1. Scan all `.bref` files in the repository.
2. Classify each file by its state (using the same symbols as `blobsy status`).
3. Aggregate counts and total sizes per state.
4. Show total tracked files and storage usage.
5. Suggest next actions based on current state.

**Use cases:**
- Quick health check of the repository
- See total storage being tracked
- Identify how many files need push/pull/commit
- Understand distribution of file states

**Flags:**
- `--json` - Machine-readable JSON output with per-state breakdowns
- `--verbose` - Show distribution by directory

**Deferred feature:** First introduced in future versions.
Complements `blobsy status` (per-file detail) with aggregate rollup view.

### `blobsy verify`

Verify local files match their ref hashes.

```bash
$ blobsy verify [path...]
Verifying 4 tracked files...
  data/bigfile.zip              ok (sha256 matches)
  data/research/report.md       MISMATCH (expected 7a3f0e..., got b4c8d2...)
  data/research/raw/resp.json   MISSING
  data/research/raw/data.parq   ok (sha256 matches)
2 ok, 1 mismatch, 1 missing.
```

Reads and hashes every file (bypasses stat cache).
For definitive integrity verification.

### `blobsy doctor`

Comprehensive diagnostic and health check command.
Runs categorized checks across configuration, hooks, integrity, and backend
connectivity.

```bash
$ blobsy doctor
  ✓  data/bigfile.zip  synced (500 MB)
  ~  data/research/report.md  modified (12 KB)

2 tracked files: 1 synced, 1 modified

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

3 issues found. Run with --fix to attempt repairs.
```

**Current checks:**

1. **Status overview** — Shows tracked file states (superset of `blobsy status`) with
   sizes and per-state counts.
2. **Configuration validation** — Config file exists, YAML valid, backend resolves,
   size/algorithm settings valid, unknown keys detected.
3. **Git hook checks** — Pre-commit and pre-push hooks: existence, blobsy-managed
   content, executable permissions.
4. **Integrity checks:**
   - `.blobsy/` directory exists and is writable
   - `.blobsy/` listed in root `.gitignore`
   - `.bref` files valid YAML with expected format version
   - No orphaned `.bref` files (local file missing, no remote key)
   - No missing `.gitignore` entries for tracked files
   - No dangling `.gitignore` entries (no corresponding `.bref`)
   - Stat cache files valid, no stale entries
5. **Backend checks** — Tool availability (AWS CLI for S3, command binaries for command
   backends), health check (connectivity and permissions).

**Flags:**
- `--fix` - Attempt to automatically fix detected issues (safe repairs only):
  - Add missing `.gitignore` entries
  - Remove dangling `.gitignore` entries
  - Create missing `.blobsy/` directory
  - Add `.blobsy/` to root `.gitignore`
  - Clean up stale/corrupt stat cache entries
  - Fix hook executable permissions
- `--verbose` - Show all checks including passing ones
- `--json` - Machine-readable output for scripting

**Exit codes:**
- `0` - No errors (warnings may be present)
- `1` - Errors detected (action required)

### `blobsy config`

Get or set configuration values with multi-level precedence support.

**Basic usage:**

```bash
$ blobsy config                     # show all config (merged from all levels)
$ blobsy config compress            # show a top-level section
$ blobsy config compress.algorithm  # show a specific key
$ blobsy config compress.algorithm zstd  # set a value in repo config
```

**Multi-level config flags:**

```bash
$ blobsy config --global compress.algorithm gzip
  # Set value in user-global config (~/.blobsy.yml)
  # Works outside git repositories

$ blobsy config --show-origin compress.algorithm
  # Show which config file a value comes from
  # Output: repo    .blobsy.yml    zstd
  # Possible origins: builtin, global (~/.blobsy.yml), repo (.blobsy.yml), subdir (<path>/.blobsy.yml)

$ blobsy config --unset compress.algorithm
  # Remove a key from repo config
  # Falls back to global or builtin default
  # Output shows effective value after removal

$ blobsy config --global --unset compress.algorithm
  # Remove a key from global config
```

**Config precedence** (highest to lowest):
1. Subdirectory `.blobsy.yml` (most specific, applies to subdirectory and descendants)
2. Repo root `.blobsy.yml` (applies to entire repository)
3. Global `~/.blobsy.yml` (user-wide defaults)
4. Built-in defaults (hardcoded)

**Scope rules:**
- Without `--global`: Operates on repository config (requires git repository)
- With `--global`: Operates on `~/.blobsy.yml` (works anywhere, even outside git repos)

**Environment variable override:**
- `BLOBSY_HOME`: Override the global config directory (default: `~`)
- Useful for testing or custom config isolation
- Example: `BLOBSY_HOME=/tmp/test blobsy config --global compress.algorithm gzip`

**JSON output:**

All config operations support `--json` for machine-readable output:

```bash
$ blobsy config --json compress.algorithm
{"schema_version":"0.1","key":"compress.algorithm","value":"zstd"}

$ blobsy config --json --show-origin compress.algorithm
{"schema_version":"0.1","key":"compress.algorithm","value":"zstd","origin":"repo","file":".blobsy.yml"}

$ blobsy config --json --global compress.algorithm gzip
{"schema_version":"0.1","message":"Set compress.algorithm = gzip","level":"info"}
```

### `blobsy hooks`

Manage the blobsy git hooks (pre-commit and pre-push).

Blobsy installs two hooks:

| Hook | When | What it does | Why it’s automatic |
| --- | --- | --- | --- |
| **pre-commit** | `git commit` | Verifies staged `.bref` files match their local files (catches modifications after tracking) | Fast local check; prevents committing stale refs |
| **pre-push** | `git push` | Auto-runs `blobsy push` to upload unpushed blobs | **Prevents data loss**: without this, other users get `.bref` pointers with no blobs to download |

**Why push is hooked but pull is not:** Pushing blobs is a safety requirement — if
`.bref` files reach the remote without their corresponding blobs, other users experience
data loss (they cannot download the files).
The cost of auto-push is bounded by what you’re committing.
Pulling, by contrast, has an unbounded cost (network time, disk space for potentially
large files) and not every user needs all blobs immediately.
Pull remains an explicit `blobsy pull` operation.
See the deferred features appendix for discussion of a future post-merge auto-pull hook.

```bash
$ blobsy hooks install
✓ Installed pre-commit hook (.git/hooks/pre-commit)
✓ Installed pre-push hook (.git/hooks/pre-push)

$ blobsy hooks uninstall
✓ Removed pre-commit hook
✓ Removed pre-push hook
```

Installed automatically by `blobsy init` (skip with `--no-hooks`). To bypass:

```bash
$ git commit --no-verify   # skip pre-commit
$ git push --no-verify     # skip pre-push
$ BLOBSY_NO_HOOKS=1 git commit  # disable via environment
```

### `blobsy check-unpushed`

Find committed `.bref` files whose blobs are missing from remote storage.

```bash
$ blobsy check-unpushed

⚠ Found 2 .bref files in HEAD with missing remote blobs:

  data/model.bin.bref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Issue: remote_key not set (never pushed)

To fix: Run 'blobsy push' to upload missing blobs.
```

Uses git blame to identify who committed each problematic `.bref`. Diagnostic tool for
when team members report “missing (no remote!)” errors.

**Flags:**
- `--json` - Machine-readable output

### `blobsy pre-push-check`

Verify all committed `.bref` files have reachable remote blobs.
CI-friendly.

```bash
$ blobsy pre-push-check

✓ All committed .bref files have remote blobs
  Checked 15 .bref files in HEAD
```

**Exit codes:**
- `0` - All `.bref` files have blobs
- `1` - One or more `.bref` files missing blobs

**Use case:** Run in CI before allowing merge to prevent commits with missing blobs from
entering the main branch.

### Command Summary

```
SETUP
  blobsy setup --auto <url>            Set up blobsy (wraps init + agent integration)
  blobsy init <url>                    Initialize blobsy config (low-level)
  blobsy config [key] [value]          Get/set configuration
       [--global]                    Use global config (~/.blobsy.yml)
       [--show-origin]               Show which config file each value comes from
       [--unset]                     Remove a config key (falls back to parent scope)
  blobsy health                        Check transport backend health (credentials, connectivity)
  blobsy doctor                        Comprehensive diagnostics and health check (Deferred: enhanced)
       [--fix]                       Auto-fix detected issues
  blobsy hooks install|uninstall       Manage git hooks (pre-commit validation, pre-push upload)

TRACKING
  blobsy add <path>...                 Track files and stage changes to git (recommended)
  blobsy track <path>...               Start tracking a file or directory (creates/updates .bref)
  blobsy untrack [--recursive] <path>  Stop tracking, keep local file (move .bref to trash)
  blobsy rm [--local|--recursive] <path>  Remove from tracking and delete local file
  blobsy mv <source> <dest>            Rename/move tracked file (Initial release: files only, preserves remote_key)

SYNC
  blobsy sync [path...]                Bidirectional: track changes, push missing, pull missing
  blobsy push [path...]                Upload local blobs to remote, set remote_key
       [--force]                     Override hash mismatch (updates .bref to match file)
  blobsy pull [path...]                Download remote blobs to local
       [--force]                     Overwrite local modifications
  blobsy status [path...]              Show state of all tracked files (○ ◐ ◑ ✓ ~ ? ⊗) (Deferred: with sizes)
  blobsy stats                         Show aggregate statistics by state (Deferred: new command)
  blobsy check-unpushed                Find committed .bref files with missing remote blobs
  blobsy pre-push-check                Verify all .bref files have remote blobs (for CI)

VERIFICATION
  blobsy verify [path...]              Verify local files match ref hashes

DOCUMENTATION
  blobsy readme                        Display the README
  blobsy docs [topic] [--list|--brief] Display user documentation

AGENT INTEGRATION
  blobsy skill                         Output skill documentation for AI agents
```

### Flags (Global)

```
--json          Structured JSON output (for agents and scripts)
--quiet         Suppress all output except errors
--dry-run       Show what would happen without doing it
--verbose       Detailed progress output
--help          Command help with usage examples
```

Note: `--force` is command-specific (push: re-push even if remote exists; pull:
overwrite local modifications; sync: force overwrite conflicts).

### Exit Codes

```
0   Success
1   Error (network, permissions, configuration)
2   Conflict (local file modified but ref not updated; pull refused)
```

## Configuration: `.blobsy.yml`

Configuration lives in `.blobsy.yml` files, placed anywhere -- like `.gitignore` or
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
Settings merge -- a subdirectory file only needs to specify what it overrides.
If no `.blobsy.yml` exists anywhere, the built-in defaults apply.

**Merge semantics:** When a setting is overridden, the entire value is replaced (not
deep-merged).
For arrays and objects, the full array/object from the more specific config
replaces the inherited one.
Example: if a subdirectory `.blobsy.yml` specifies `externalize.always: ["*.parquet"]`,
it completely replaces the parent’s `always` list -- it does not append to it.

**Important:** Any setting that affects how remote bytes are stored (compression
algorithm, checksum algorithm) must be in git-tracked config (repo-level `.blobsy.yml`),
not in global/user config.
If two users have different local configs that affect remote representation, they
produce different remote blobs, breaking sync.
User-global config should only contain preferences that don’t affect remote storage
(e.g., `sync.tools`, `sync.parallel`).

### Built-in Defaults

These are compiled into blobsy and form the implicit base of every hierarchy.
Any `.blobsy.yml` at any level can override any part of this:

```yaml
# blobsy built-in defaults (not a file -- hardcoded in blobsy)

externalize:
  min_size: 200kb
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
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"  # default (timestamp+hash)

sync:
  tools: [aws-cli, rclone]        # ordered preference list; first available is used
  parallel: 8

checksum:
  algorithm: sha256
```

This means blobsy works out of the box with zero configuration.
`blobsy track data/` uses sensible rules even if no `.blobsy.yml` exists.
The only thing that *must* be configured is the backend (bucket, region, etc.)
-- everything else has a working default.

### Externalization Rules

When `blobsy track <dir>` runs, it decides which files get externalized (`.bref` +
gitignored) vs. left alone (committed directly to git).
The decision is based on **size** and **file type**:

```yaml
# .blobsy.yml
externalize:
  min_size: 200kb                  # files below this stay in git (default: 200kb)
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

### Compression Rules

Blobsy compresses files before uploading to the remote and decompresses on pull.
Node 24+ has built-in zstd, gzip, and brotli support in `node:zlib` -- no external
dependencies or CLI tools needed.
Compression runs in-process with streaming support.

Compression is controlled by **file type** and **size**:

```yaml
# .blobsy.yml
compress:
  min_size: 100kb                  # don't bother compressing tiny files
  algorithm: zstd                  # zstd (default) | gzip | brotli | none
  always:                          # always compress these
    - "*.json"
    - "*.csv"
  never:                           # never compress these (already compressed)
    - "*.gz"
    - "*.zst"
    - "*.zip"
    - "*.parquet"
    - "*.png"
    - "*.jpg"
```

The compression skip list must be in repo-level config (committed to git) because it
affects remote keys.
Two users with different skip lists would produce different remote blobs for the same
file.

### Ignore Patterns

Files matching `ignore` patterns are skipped entirely by `blobsy track`. Same syntax as
`.gitignore`. The built-in defaults cover common patterns (`__pycache__/`, `.DS_Store`,
`node_modules/`).

### Backend and Sync Settings

Backend and sync settings live in the repo-root `.blobsy.yml` (or user-global):

```yaml
# .blobsy.yml (repo root)
backend: default

backends:
  default:
    url: s3://my-datasets/project-v1/
    region: us-east-1

remote:
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"  # default (content-addressable)
  # Or: "{git_branch}/sha256/{content_sha256}"  # branch-isolated
  # Or: "shared/{repo_path}"                     # global shared

sync:
  tools: [aws-cli, rclone]      # ordered preference list; first available is used
  parallel: 8
```

### Full Example

A repo with sensible defaults at the root and an override for a data-heavy subdirectory:

```yaml
# <repo>/.blobsy.yml -- repo root
backend: default
backends:
  default:
    url: s3://my-datasets/my-project/
    region: us-east-1

remote:
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"  # default (timestamp+hash)

externalize:
  min_size: 200kb

compress:
  algorithm: zstd

ignore:
  - "__pycache__/"
  - ".DS_Store"
```

```yaml
# <repo>/data/raw/.blobsy.yml -- override for raw data dir
externalize:
  min_size: 0                     # externalize everything here, even small files
  never: []                       # no exceptions

compress:
  never:                          # raw data is already compressed
    - "*.parquet"
    - "*.gz"
```

## Backend System

Three backend types are supported: `s3` (any S3-compatible store including R2, MinIO,
B2, Tigris), `local` (directory-to-directory for dev/testing), and `command` (arbitrary
commands for unsupported backends like SCP, rsync, custom APIs).

Blobsy delegates file transfers to external CLI tools (`aws-cli`, `rclone`) or falls
back to the built-in `@aws-sdk/client-s3`. It uses these as copy engines (per-file
`cp`), not diff engines -- blobsy owns the diffing via `.bref` hashes.

Key properties:

- **Atomic writes:** All downloads go to a temp file, get hash-verified, then atomically
  renamed. No partial files on interruption.
- **Health checks:** Before bulk transfers, a lightweight check validates credentials,
  bucket access, and network.
  Fails fast with one clear error instead of N concurrent failures.
  Exposed as `blobsy health` command.
- **Compression:** Handled by blobsy (not the transport tool).
  Push compresses to temp, uploads, cleans up.
  Pull downloads, decompresses, writes final.
- **Error handling:** Both stdout and stderr captured from transport tools.
  Errors are categorized (auth, network, permission, not_found, quota, storage_full)
  with context-aware troubleshooting suggestions.
  Partial failures continue remaining files.
- **Authentication:** No custom auth.
  Uses standard credential chains (env vars, AWS profiles, IAM roles, rclone config).

### Command Backend Execution Model

The `command` backend executes user-configured commands for push, pull, and exists
checks. Templates use `{local}`, `{remote}`, `{relative_path}`, and `{bucket}` as
placeholder variables, plus `$NAME` or `${NAME}` for environment variables.

**Shell-free execution.** Blobsy never passes commands through a shell interpreter.
Instead:

1. The template string is split on whitespace into discrete tokens.
2. Blobsy template variables (`{name}`) are expanded per token.
3. Environment variables (`$NAME`, `${NAME}`) are expanded per token.
4. Each fully expanded token is validated against a strict character allowlist
   (alphanumeric, space, and `/ _ - . + = : @ ~ , % #`).
5. The command and arguments are passed as a pre-parsed array to `execFileSync`,
   bypassing shell interpretation entirely.

This eliminates shell injection by construction -- there is no shell to inject into.
If an expanded value contains any disallowed characters (quotes, semicolons, pipes,
backslashes, etc.), blobsy rejects it with a `ValidationError` listing the specific
offending characters and the full set of allowed characters.

**Consequences of no-shell execution:**

- Shell features (pipes, redirects, subshells, globbing) are not available in command
  templates. If complex shell logic is needed, wrap it in a script and reference the
  script in the template.
- Environment variable values containing spaces are preserved as part of a single token
  (no word splitting), which is safer than shell behavior.
- Template variable names cannot contain spaces (they are `\w+` matches).

Example:

```yaml
backends:
  default:
    type: command
    bucket: my-bucket
    push_command: aws s3 cp {local} s3://{remote}
    pull_command: aws s3 cp s3://{remote} {local}
    exists_command: aws s3 ls s3://{remote}
```

See [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md) for
full details: backend configuration, S3-compatible endpoint setup, transfer tool
selection, command template variables, atomic write implementation, error message format
(human + JSON), all common error scenarios, and health check behavior.

## Per-File State Model

Each tracked file has state across three layers:

| Layer | What | Where |
| --- | --- | --- |
| **Local** | Actual file on disk | `data/bigfile.zip` |
| **Ref** | `.bref` committed in git | `data/bigfile.zip.bref` |
| **Remote** | Blob in remote store | `s3://bucket/.../bigfile.zip` |

### State Table

Let `L` = local file hash, `R` = ref hash (in git HEAD), `B` = blob exists in remote.

| L | R | B | State | `status` | `sync` |
| --- | --- | --- | --- | --- | --- |
| h | h | yes | **Synced** | ok | nothing |
| h | h | no | **Needs push** | ok (not pushed) | pushes blob |
| (none) | h | yes | **Needs pull** | missing | pulls blob |
| (none) | h | no | **Data loss** | missing (no remote!) | errors |
| h' | h | yes | **Modified locally** | modified | warns |
| h' | h | no | **Modified + not pushed** | modified (not pushed) | warns |
| h | (none) | -- | **Untracked** | (not shown) | (ignored) |
| (none) | (none) | old | **Orphaned remote** | (not shown) | `gc` candidate (Deferred) |

## Conflict Model

### Why Conflicts Are Trivially Resolved

Each file has its own `.bref`. Two people modifying different files change different
`.bref` files. Git auto-merges with zero conflicts.

The only conflict case: two people modify **the same file**. Then git sees a conflict on
that file’s `.bref`:

```
<<<<<<< HEAD
hash: sha256:aaa111...
size: 1048576
=======
hash: sha256:ccc333...
size: 2097152
>>>>>>> origin/main
```

Resolution is the same as any git conflict: pick one side, or merge manually.

```bash
# Accept theirs
$ git checkout --theirs data/results.json.bref
$ git add data/results.json.bref
$ blobsy pull data/results.json    # get their version of the actual file
```

No custom resolution tooling needed.
Every developer already knows how to resolve git conflicts.

### Conflict Detection

Git handles `.bref` merge conflicts.
But there is a second class of conflict that git cannot see: **payload-vs-ref
desynchronization**. Since payload files are gitignored, git pull can update a `.bref`
file while leaving the local payload stale.
Without detection, `blobsy sync` cannot distinguish “user modified the file” from “git
pull updated the ref” and may incorrectly push stale content, reverting someone else’s
changes.

Blobsy uses a three-layer defense:

1. **Prevention (Primary):** A pre-commit hook (installed by `blobsy init`) auto-runs
   `blobsy push` when committing `.bref` files.
   This ensures blobs are uploaded before refs enter git history.
   `blobsy push` also verifies the local file hash matches the `.bref` hash, catching
   files modified after tracking.

2. **Detection (Secondary):** The stat cache provides the merge base for three-way
   conflict detection during sync.
   For each file, blobsy compares the local hash, the `.bref` hash, and the cached hash
   (last known state) to determine the correct action.
   See [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md) for the full decision
   table and algorithm.

3. **Attribution (Tertiary):** When a blob is missing from remote storage, error
   messages use git blame to identify who committed the `.bref` without pushing, with
   actionable resolution steps.

### Single-Writer Model

Blobsy assumes one writer per tracked file at a time.
This is the common case: each developer works on their own files.
Content-addressable storage means concurrent pushes of different files never interfere
-- different content hashes produce different remote keys.

If two users push the same content for the same file, they write the same key
(idempotent PUT). If they push different content, both blobs exist in the remote; the
git merge of `.bref` files determines which one wins.

## Gitignore Management

`blobsy track` manages `.gitignore` with explicit per-file entries.
No wildcards, no negation patterns.
Every tracked file gets its own gitignore line.

```gitignore
# >>> blobsy-managed (do not edit) >>>
bigfile.zip
# <<< blobsy-managed <<<
```

In `data/research/.gitignore`:

```gitignore
# >>> blobsy-managed (do not edit) >>>
model.bin
raw/data.parquet
# <<< blobsy-managed <<<
```

`blobsy track` adds a line.
`blobsy untrack` removes it.

Entries are placed in a clearly marked section in the `.gitignore` file in the same
directory as the tracked path (following the DVC convention), using paths relative to
that directory. If no `.gitignore` exists in that directory, one is created.
This keeps gitignore entries co-located with the things they ignore.

The `.bref` files live adjacent to their data files.
Since only the data files are gitignored (not the directory), git sees the `.bref` files
normally. No negation patterns needed.

For a directory with 1,000 tracked files, `.gitignore` gets 1,000 lines in the
blobsy-managed block.
This is fine -- `.gitignore` files can be large, and the lines are sorted and
predictable.

## The `.blobsy/` Directory

Every repo with blobsy tracking has a `.blobsy/` directory at the repo root.
It is committed to git.

```
.blobsy/
  trash/                          # expired .bref files from blobsy untrack
    data/bigfile.zip.bref         # preserves path structure
    data/research/old-model.bin.bref
```

### Purpose

When you `blobsy untrack` a file, the `.bref` is moved here instead of deleted.
This serves two purposes:

1. **GC paper trail (Deferred).** `blobsy gc` (Deferred) can scan `.blobsy/trash/` to
   find remote blobs that were once tracked but are no longer referenced by any live
   `.bref`. Without the trash, GC would have to walk the entire git history to discover
   orphaned blobs.

2. **Undo safety net.** If you untrack something by mistake, the `.bref` is still in
   `.blobsy/trash/` (and in git history).
   You can recover it.

### GC Cleans the Trash (Deferred)

`blobsy gc` (Deferred) removes trash entries whose remote blobs have been cleaned up.
Trash entries whose blobs are still referenced by other live `.bref` files on other
branches are kept until those references are also gone.

### What `.blobsy/` Contains

- **Trash** for soft-deleted refs (see above).
- **Stat cache** at `.blobsy/stat-cache/` (gitignored, machine-local).
  One JSON file per tracked file.
  See [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md).

### What `.blobsy/` Does Not Contain

- **No config.** Config lives in `.blobsy.yml` files (hierarchical, placed anywhere).
- **No manifests.** There are no manifests.

## Security Model

### Secure Command Execution

Blobsy applies defense-in-depth to command backend execution:

1. **No shell.** Commands are executed via `execFileSync` with pre-parsed argument
   arrays. No shell interpreter (`/bin/sh`, `cmd.exe`) is involved, eliminating shell
   injection entirely.

2. **Per-token expansion.** The template is split on whitespace before any variable
   substitution. Template variables (`{local}`, etc.)
   and environment variables (`$NAME`) are expanded within individual tokens, never
   across token boundaries.

3. **Strict character validation.** Each fully expanded token is validated against
   `[-a-zA-Z0-9 /_.+=:@~,%#]*`. Tokens containing quotes, semicolons, pipes,
   backslashes, or other shell metacharacters are rejected with a clear error listing
   the offending characters and the allowed set.

These three layers mean that even if an attacker controls a template variable’s value
(e.g., via a crafted `.bref` file), they cannot escape the argument boundary or trigger
shell interpretation.

### Backend Authentication

Blobsy itself handles no credentials.
Authentication is delegated to the backend’s standard credential chain (AWS IAM, env
vars, shared credentials files).
No secrets are ever stored in `.blobsy.yml` or `.bref` files.

## Workflows and Scenarios

### Single User: Track, Push, Pull

```bash
# Setup (one-time)
$ blobsy init s3://my-datasets/project-v1/ --region us-east-1
Created .blobsy.yml
Installed pre-commit hook

# Track files
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore

# Commit refs to git
$ git add data/model.bin.bref .gitignore .blobsy.yml
$ git commit -m "Track model with blobsy"

# Push blobs to remote
$ blobsy sync
  data/model.bin   pushed (500 MB)
Done. 1 pushed.

# Push git
$ git push
```

On another machine:

```bash
$ git clone <repo>
$ blobsy sync
  data/model.bin   pulled (500 MB)
Done. 1 pulled.
```

### Two Users: Non-Conflicting Changes

```bash
# User A modifies report.md
A: vim data/research/report.md
A: blobsy track data/research/report.md    # updates .bref
A: git add data/research/report.md.bref && git commit -m "Update report"
A: blobsy sync                             # pushes blob
A: git push

# User B modifies data.parquet (concurrently)
B: python process.py  # writes data/research/data.parquet
B: blobsy track data/research/data.parquet
B: git add data/research/data.parquet.bref && git commit -m "Update data"
B: blobsy sync
B: git pull                              # auto-merge: different .bref files
B: git push
B: blobsy sync                           # pushes blob
```

No conflicts. Different files = different `.bref` files = auto-merge.

### Two Users: Same File Conflict

```bash
# User A modifies results.json
A: blobsy track data/results.json
A: git add data/results.json.bref && git commit
A: blobsy sync && git push

# User B also modified results.json
B: blobsy track data/results.json
B: git add data/results.json.bref && git commit
B: git pull
# CONFLICT on data/results.json.bref

# Resolve: take A's version
B: git checkout --theirs data/results.json.bref
B: git add data/results.json.bref
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
$ git add data/new-results.parquet.bref && git commit
$ blobsy sync && git push

# Merge back to main
$ git checkout main && git merge feature/new-data
# .bref files merge cleanly (new file = new .bref = no conflict)
$ blobsy sync    # blobs already in remote from feature branch push
$ git push
```

**No post-merge gap.** The blobs were pushed from the feature branch.
After merge, the `.bref` files on main point to the same blobs (same content hash = same
remote key). `blobsy sync` on main has nothing to do -- the blobs are already there.

This completely eliminates the post-merge promotion problem from the original design.

### Directory with Mixed Files

A directory containing both large files (externalized via blobsy) and small files
(committed to git directly).
The externalization rules in `.blobsy.yml` handle this automatically.

```bash
$ blobsy track data/analysis/
Scanning data/analysis/...
  data/analysis/model-weights.bin    (120 MB, .bin)   -> externalized (.bref)
  data/analysis/embeddings.parquet   (45 MB, .parquet) -> externalized (.bref)
  data/analysis/process.py           (3 KB, .py)       -> kept in git
  data/analysis/config.yaml          (1 KB, .yaml)     -> kept in git
  data/analysis/README.md            (2 KB, .md)       -> kept in git
2 files tracked, 3 kept in git.

$ git add data/analysis/*.bref .gitignore
$ git commit -m "Track analysis data with blobsy"
```

Small files stay in git.
Large files get `.bref` files and gitignore entries.
Both coexist in the same directory with no manual configuration needed.

### CI Pipeline

```bash
# CI pulls data needed for tests
$ blobsy pull
  data/model.bin           pulled (500 MB)
  data/test-fixtures/...   pulled (12 files, 50 MB)
Done. 13 pulled.

# Run tests with the data
$ npm test

# Optionally verify integrity
$ blobsy verify
13 files verified, all ok.
```

CI environments work naturally.
Content-addressable storage means there are no branch-prefix issues -- CI on any branch
or detached HEAD pulls the same blobs referenced by the committed `.bref` files.

## Corner Cases and Pitfalls

### Push/Commit Coordination

**Pushed data but forgot to commit the ref.** User runs `blobsy push` (data uploads to
remote) but doesn’t `git add` and `git commit` the updated `.bref` file.
Other users have no way to know the remote data changed.
The ref in git still references the old hash.

Recovery: commit the ref file.
Until then, other users see no change.

Detection: `blobsy status` on the pusher’s machine shows “up-to-date” (local matches
ref). The problem is invisible to the pusher -- it only manifests when other users don’t
see the update. This is the most common mistake.

**Committed the ref but forgot to push data.** User updates a file, commits the `.bref`,
but doesn’t run `blobsy push`. Other users pull from git, see the updated ref, run
`blobsy pull`, and the remote blob doesn’t exist.

Recovery: the original user runs `blobsy push` to upload the data that matches the
committed ref.

Prevention: the pre-push hook (installed by `blobsy init`) auto-uploads blobs before git
refs are pushed, ensuring blobs and refs arrive at the remote together.
The pre-commit hook separately validates that staged `.bref` hashes still match their
local files, catching modifications after tracking.

Detection: `blobsy pull` errors with “missing (no remote!)”. `blobsy check-unpushed`
finds all such cases.
In CI, `blobsy pre-push-check` can catch this before merge.

**Pushed data, then switched branches without committing.** User runs `blobsy push` on
branch A, then `git checkout B` without committing the updated ref.
The ref update is lost.
The data is in the remote but nothing in git references it.

Recovery: switch back to branch A; the uncommitted ref changes may still be in the
working tree. If lost, re-run `blobsy track` then `blobsy push`.

**File modified after tracking, before commit.** User runs `blobsy track`, then modifies
the file before committing.
The `.bref` hash no longer matches the file.
The pre-commit hook catches this: it verifies that staged `.bref` hashes match the local
files, blocking the commit with a hash mismatch error.
Resolution: re-run `blobsy track` to update the `.bref`.

### Interrupted Transfers

**Push interrupted midway.** Some files uploaded, others not.
Re-running `blobsy push` is safe: already-uploaded files are detected via hash
comparison (content-addressable = same hash = same key = already exists).
Only remaining files are transferred.

**Pull interrupted midway.** Some files downloaded, others missing.
Re-running `blobsy pull` is safe: already-downloaded files that match the ref hash are
skipped. Partially downloaded files (wrong size or hash) are re-downloaded.
Per-file atomic writes (temp+rename) prevent corrupt partial files.

### Git Workflow Interactions

**`git stash` doesn’t affect blobsy data.** Stashing saves the ref file changes but
leaves the actual data (gitignored) untouched.
After `git stash pop`, the ref is restored but the local data may have changed in the
meantime. Run `blobsy status` after unstashing to check consistency.

**`git revert` of a ref update.** Reverting a commit that updated a ref file restores
the old hash in the ref.
The local data still has the newer content.
`blobsy status` shows “modified” (local doesn’t match ref).
`blobsy pull` downloads the older version from remote (the old blob still exists in
content-addressable storage -- it’s never overwritten).

**`git rebase` / `git cherry-pick` with ref conflicts.** Ref files can conflict during
rebase just like any other file.
Standard git conflict resolution applies.
After resolving, run `blobsy status` to verify the ref is consistent with local data,
and `blobsy sync` if needed.

**`git checkout` of an old commit.** With content-addressable storage, old blobs are
preserved in the remote (until GC removes unreferenced ones).
Checking out an old commit and running `blobsy pull` works reliably as long as the old
blobs haven’t been garbage collected.
In the initial release, use `blobsy rm` to manually remove blobs you no longer need.
In future versions, `blobsy gc` will provide automatic cleanup with age-based retention.

**Manually edited `.bref` file.** If a user or tool modifies the hash, size, or other
fields in a ref file, `blobsy status` may show incorrect state.
`blobsy verify` detects mismatches between the ref hash and the actual local file.
`blobsy track` recalculates the hash and overwrites the ref with correct values.

### Gitignore Misconfiguration

**Accidentally committed large files to git.** If `.gitignore` doesn’t cover a
blobsy-tracked file, `git add .` stages it.
Large files end up in git history permanently.

Prevention: `blobsy track` always adds the file to `.gitignore` before creating the
`.bref`. Verify `.gitignore` after setup.
`blobsy status` shows which files are tracked -- cross-check against `.gitignore`.

### Credential and Backend Errors

**Missing or expired credentials.** `blobsy push` and `blobsy pull` fail with an
authentication error from the underlying transport tool.
The error message comes from the transport layer, not from blobsy.

Recovery: configure credentials via the standard mechanism for the backend.

**Wrong transfer tool selected.** A user has aws-cli installed for other purposes, but
it’s not configured for the blobsy backend’s endpoint or region.
Tool detection performs a capability check and falls through to the next tool in the
`sync.tools` list. If detection still fails, override `sync.tools` to a single-element
list (e.g., `sync.tools: [rclone]`) in config.

### Large Directories

**10,000 files = 10,000 `.bref` files.** Git handles millions of files routinely.
In file browsers, the `.bref` files are interspersed with the actual files -- but the
actual files are gitignored, so `git ls-files` only shows `.bref`s.

For extreme cases, a future option could store `.bref` files in a parallel directory
(e.g., `data/research.brefs/`) for cleanliness.
This is deferred to a future version..

## Agent and Automation Integration

### Machine-Readable Output

All commands support `--json`. JSON output includes a `schema_version` field (e.g.,
`"schema_version": "0.1"`) so automation can detect breaking changes:

```bash
$ blobsy status --json
{
  "schema_version": "0.1",
  "tracked": 12,
  "modified": 2,
  "missing_local": 1,
  "files": [
    {
      "path": "data/prices.parquet",
      "status": "modified",
      "local_sha256": "abc...",
      "ref_sha256": "def...",
      "size": 15728640
    }
  ]
}
```

### Self-Documenting Ref Files

Every `.bref` file starts with:

```
# blobsy -- https://github.com/jlevy/blobsy
```

An agent encountering a `.bref` file for the first time can read this header, visit the
URL or run `npx blobsy --help`, and understand the system without external
documentation.

### Fully Non-Interactive

Every command is non-interactive.
No command ever prompts for input.
This makes blobsy safe to call from scripts, CI pipelines, and agent tool loops.

- `--force` for destructive operations.
- `--dry-run` for preview.
- Missing required flags produce a usage error with examples (not a prompt).

`blobsy init` requires a URL on first run (e.g.,
`blobsy init s3://my-data/prefix/ --region us-east-1`). This is deliberate: explicit
arguments are more reliable for agents and scripts, and produce a clear audit trail in
shell history.

## Implementation Notes

### Language and Distribution

TypeScript. Distributed via npm as `blobsy`. Usable via:

- `npx blobsy@latest <command>` (no install)
- `npm install -g blobsy` (global install)
- `pnpm add -D blobsy` (project dev dependency)

Blobsy is a standalone CLI. Other tools can invoke it as a subprocess or use its npm
package as a library.

### Key Dependencies

| Dependency | Purpose |
| --- | --- |
| `commander` | CLI parsing |
| `yaml` | Ref and config file parsing |
| `@aws-sdk/client-s3` | Built-in S3 transfer fallback |
| `fast-glob` | File discovery for directory tracking |

Compression uses Node.js built-in `node:zlib` (zstd, gzip, brotli) -- no external
compression dependencies.

**Minimum Node.js version:** Node.js 22.15.0 or later (required for `node:zlib` zstd
support and LTS stability).
See `engines` in `package.json` for the authoritative minimum.
Development and CI use Node.js 24 (see `.nvmrc`).

### No Daemon

See [Design Decisions](#design-decisions).
Pure CLI with no background processes.
If the stat cache is missing, blobsy auto-rebuilds it where unambiguous and errors with
resolution guidance where ambiguous.

### Testing

See [blobsy-testing-design.md](blobsy-testing-design.md) for the full testing plan: unit
tests, integration tests, golden/snapshot tests, conflict detection tests, and CI
configuration.

## Initial Release Scope

### What blobsy does

- Track files via per-file `.bref` ref files committed to git
- Content-addressable remote storage with automatic dedup
- Push/pull/sync with pluggable backends and configurable transfer tools
- Per-file compression via Node.js built-in zstd/gzip/brotli
- SHA-256 integrity verification
- Content-addressable garbage collection (Deferred)
- Hierarchical `.blobsy.yml` configuration with externalization and compression rules
- Per-file gitignore management
- Machine-readable `--json` output for agents
- `blobsy doctor` for basic diagnostics (Deferred: enhanced with error detection and
  auto-fix)
- `blobsy status` for per-file state (Deferred: enhanced with file sizes)
- Full file versioning via git history of `.bref` files

### What blobsy does not do

- Sub-file delta sync (whole-file granularity only)
- Cross-repo deduplication
- Multi-writer merge logic (single-writer model; git handles ref conflicts; stat cache
  detects payload-vs-ref desync but does not auto-resolve -- see
  [Conflict Detection](#conflict-detection))
- Signed refs or end-to-end cryptographic verification chains
- Lazy materialization (pull downloads everything)
- Bidirectional sync conflict resolution strategies (sync = push missing + pull missing;
  no configurable `--strategy`)
- Access control (relies on backend IAM)
- Remote staleness detection via provider hashes
- Web UI
- Parallel `.bref` directory option (`.bref` files always adjacent to data files)
- Batched multi-file transfer / transfer engine abstraction (The initial release uses
  per-file concurrency with a pool; Future versions will add pluggable `TransferEngine`
  with batch support)

These are candidates for future versions if demand warrants.

### What’s Deferred

- **Transfer engine abstraction.** The initial release uses per-file CLI spawning with a
  concurrency pool. Future versions will introduce a pluggable `TransferEngine` interface
  that supports both per-file and batched transfer modes:

  ```typescript
  interface TransferEngine {
    // Per-file transfer (Initial release model, always supported)
    transferFile(src: string, dest: string): Promise<void>

    // Batch transfer (Deferred optimization, optional)
    transferBatch?(files: Array<{src: string, dest: string}>): Promise<void>
  }
  ```

  When `transferBatch` is available, blobsy passes all files in a single call, letting
  the engine manage its own concurrency (connection pooling, worker threads, etc.). This
  eliminates per-file process spawn overhead and enables tools like `s5cmd` (batch mode
  via `run` command) and `rclone` (`--files-from` flag) to operate at peak throughput.

- **Additional transfer tool presets.** The initial release supports `aws-cli` and
  `rclone`. Future versions will add first-class presets for:
  - `s5cmd` -- Go-based, fastest for many-file workloads via batch mode.
  - `gcloud` -- native GCS transfers with ADC auth (no HMAC keys).
  - `azcopy` -- native Azure Blob transfers.

  Each preset implements `TransferEngine` with tool-specific optimizations (e.g., s5cmd
  batch file, rclone `--files-from`, gcloud parallel composite uploads).

- **Parallel `.bref` directory option.** Storing `.bref` files in a parallel directory
  (e.g., `data/research.brefs/`) instead of adjacent to data files.

- **Garbage collection (`blobsy gc`).**

  > **V2 Feature - Design Only**
  > 
  > The garbage collection system described in this section is a **design specification
  > for V2**. It is **not implemented in V1**. This section serves as the architectural
  > foundation for future implementation.

  Removes remote blobs not referenced by any `.bref` file in any reachable git branch or
  tag. With `blobsy rm` available in the initial release for manual cleanup, automatic GC
  is less critical and is deferred to a future version.

  **Safety requirements (future versions design):**

  - **MUST require explicit safety parameter:** Either `--depth=N` (only scan last N
    commits on each branch) or `--age="duration"` (only remove blobs older than
    specified duration like “7 days” or “30d”).
  - **MUST support `--dry-run` mode** showing what would be removed before actual
    deletion.
  - **Algorithm:**
    1. Collect all `remote_key` values from `.bref` files across all reachable
       branches/tags (uses `git for-each-ref` to find all branch and tag refs)
    2. Apply depth/age limits to determine which commits to scan
    3. Scan `.blobsy/trash/` for expired refs
    4. List all objects in remote storage (within configured bucket + global prefix)
    5. Delete remote objects whose key isn’t in the referenced set

  **Examples:**

  ```bash
  # Preview what would be removed (required before actual GC)
  blobsy gc --depth=5 --dry-run

  # Remove blobs not referenced in last 5 commits of any branch
  blobsy gc --depth=5

  # Remove blobs older than 30 days that aren't referenced
  blobsy gc --age="30 days"

  # Combine constraints
  blobsy gc --depth=10 --age="7 days"
  ```

  **Template-agnostic:** GC works with any key template by examining actual `remote_key`
  values in `.bref` files, correctly handling content-addressable, branch-isolated,
  shared, and mixed layouts.

  ## GC Implementation Specification (V2)

  ### Reachability Algorithm

  **Goal:** Delete remote blobs not referenced by any `.bref` in reachable commits.

  **Algorithm:**

  ```python
  def gc_reachability(depth='all', older_than=None, dry_run=False):
      # Step 1: Collect all refs to scan
      if depth == 'HEAD':
          refs_to_scan = [current_HEAD]
      elif depth == 'branch':
          refs_to_scan = [current_branch_commits()]
      else:  # depth == 'all'
          refs_to_scan = all_commits_reachable_from_all_branches_and_tags()

      # Step 2: Build reachable set
      reachable_remote_keys = set()
      for commit in refs_to_scan:
          bref_files = find_bref_files_in_commit(commit)
          for bref_path in bref_files:
              bref = read_bref_from_commit(commit, bref_path)
              if bref.remote_key:
                  reachable_remote_keys.add(bref.remote_key)

      # Step 3: List all remote blobs
      all_remote_keys = backend.list_all_blobs()

      # Step 4: Compute orphans
      orphaned_keys = all_remote_keys - reachable_remote_keys

      # Step 5: Apply age filter
      if older_than:
          orphaned_keys = filter_by_age(orphaned_keys, older_than)

      # Step 6: Delete (or dry-run report)
      if dry_run:
          print(f"Would delete {len(orphaned_keys)} orphaned blobs:")
          for key in orphaned_keys:
              print(f"  {key}")
          return orphaned_keys
      else:
          for key in orphaned_keys:
              backend.delete_blob(key)
          print(f"Deleted {len(orphaned_keys)} orphaned blobs")
          return orphaned_keys
  ```

  **Parameters:**

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `--depth` | enum | `all` | Scan depth: `all` (all branches/tags), `branch` (current branch only), `HEAD` (current commit only) |
| `--older-than` | duration | none | Only delete blobs older than this age (e.g., `30d`, `6mo`, `1y`) |
| `--dry-run` | boolean | false | Show what would be deleted without actually deleting |
| `--include-worktree` | boolean | false | If true, also consider `.bref` files in working tree (not just HEAD) |

**Example Usage:**

```bash
# Dry run: see what would be deleted
blobsy gc --dry-run

# Delete orphaned blobs older than 30 days
blobsy gc --older-than=30d

# Aggressive: delete all orphaned blobs
blobsy gc

# Conservative: delete only from current branch, older than 90 days
blobsy gc --depth=branch --older-than=90d
```

**Concurrent Operation Handling:**

| Scenario | Behavior |
| --- | --- |
| GC runs while working tree has uncommitted `.bref` changes | **Error:** “Cannot run GC with uncommitted .bref files. Commit or stash changes.” |
| GC runs during active `push` operation | **Safe:** Newly-pushed blobs have refs in working tree; won’t be deleted (if `--include-worktree` enabled) |
| Multiple users run GC concurrently | **Safe:** Deletion is idempotent; last delete wins (both see same orphans) |
| User pushes while GC is running | **Risk:** Blob could be deleted between push and commit. **Mitigation:** Always commit immediately after push (pre-commit hook enforces this) |

**Safety Guarantees:**

1. **Never deletes blobs referenced in HEAD** (any branch, any tag)
2. **Dry-run by default recommended** for first GC run
3. **Age-based safety**: `--older-than` prevents deleting recent blobs
4. **Worktree protection**: Optional `--include-worktree` flag protects uncommitted refs

**Performance:**

- Scanning 10,000 commits with 1,000 `.bref` files each: ~30 seconds
- Listing 100,000 remote blobs: ~10 seconds (S3 `ListObjectsV2` pagination)
- Total GC time for large repo: ~1-2 minutes

**Future Optimization (V3):**

- Incremental GC: Track last GC timestamp, only scan new commits

- Bloom filter: Use probabilistic data structure for faster reachability checks

- **Multi-backend routing.** Routing different directories to different backends.

- **Dictionary compression.** zstd dictionary training for 2-5x improvement on small
  files sharing structure.

- **Sub-file delta sync.** Transfer only changed portions of large files.

- **Remote staleness detection via provider hashes.** Store ETag/CRC from upload
  responses for cheap `HeadObject`-based checks.

- **Export/import specification.** `blobsy export` / `blobsy import` for tar.zst
  archives (offline sharing, backup, migration).

- **Enhanced status and stats commands.**
  - **`blobsy stats` (new command):** Aggregate statistics across all tracked files,
    grouped by state (✓ ○ ◐ ◑ ~ ? ⊗). Shows file counts and total sizes per state,
    suggests next actions, and provides a high-level health overview.
    Fully offline (reads from `.bref` metadata).
    Use `blobsy stats` for quick repo health check; `blobsy status` for per-file detail.
  - **`blobsy status` enhancement:** Add human-readable file sizes (KB, MB, GB) to
    per-file output for consistency with `blobsy stats`.

- **Enhanced `blobsy doctor` diagnostics.** Expand `blobsy doctor` to be a comprehensive
  health check and troubleshooting tool:
  - **Aggregate stats rollup** (superset of `blobsy stats`)
  - **Common error detection:**
    - Missing `.gitignore` entries for tracked files
    - Orphaned `.gitignore` entries (file no longer tracked)
    - Invalid `.bref` files (malformed YAML, unsupported format versions)
    - Uncommitted refs after push (push-commit coordination gap)
    - Modified files not re-tracked
    - Stale stat cache entries
    - Credential expiration warnings
  - **Context-aware troubleshooting advice:**
    - How to fix each detected problem
    - Links to relevant documentation sections
    - Common workflows that might have caused the issue
  - **Integration validation:**
    - Test upload/download to backend (write + delete test object)
    - Compression library availability check
    - Transfer tool version compatibility
    - Git repository health (no corruption)
    - `.blobsy/` directory structure validity
  - **Extensible diagnostics framework:**
    - New checks added as common errors are discovered in production
    - Plugin system for custom health checks (future)
  - **Auto-fix mode:** `blobsy doctor --fix` attempts safe repairs (add missing
    `.gitignore` entries, remove orphaned entries, clean stale cache, remove orphaned
    temp files)
  - **Exit codes:** 0 = all good, 1 = warnings (functional but suboptimal), 2 = errors
    (action required)

  **Rationale:** `blobsy doctor` becomes the first command to run when something seems
  wrong. It detects common mistakes (especially the push-without-commit and
  modify-without-retrack patterns), explains what happened, and suggests fixes.
  This reduces support burden and helps users self-diagnose issues.

## What This Design Eliminates

From the original design, the following concepts are no longer needed:

- **Manifests** (remote or inline) -- gone entirely.
  Git is the manifest.
- **Directory pointer type** -- no `type: directory`, just files.
- **`manifest_sha256`** -- no manifest to hash.
- **Namespace prefixes / branch isolation** -- content-addressable dedup replaces branch
  prefixes. No `branches/{branch}` namespace mode.
- **`blobsy commit`** -- `blobsy track` handles hashing (idempotent: track + update).
- **`blobsy resolve`** -- standard git conflict resolution works for `.bref` merges.
  Payload-vs-ref desync is detected automatically (see
  [Conflict Detection](#conflict-detection)); no explicit resolve command needed.
- **`blobsy ns ls` / `blobsy ns show` / `blobsy ns copy` / `blobsy promote`** -- no
  namespaces to manage.
- **Post-merge promotion** -- blobs are where they are, refs point to them.
- **Delete semantics debate** -- old blobs exist until GC; new pushes never overwrite
  (content-addressed).
- **Bidirectional sync complexity** -- `sync` = push missing + pull missing; no delete
  cascades.

## Appendix: Deferred Features and Roadmap

This section consolidates all features designed but deferred to future versions.

### V1.1 Features

| Feature | Status | Scope |
| --- | --- | --- |
| **Transfer tool delegation** (rclone) | ✅ Implemented via RcloneBackend | ~2 weeks |
| **GCS backend** (`gs://`) | ✅ Implemented via RcloneBackend | ~1 week |
| **Azure Blob backend** (`az://`) | ✅ Implemented via RcloneBackend | ~1 week |
| **Command backend health checks** (user-defined) | Deferred; optional | ~3 days |
| **blobsy clean command** | Deferred; auto cleanup sufficient | ~2 days |

### V2 Features (No Timeline)

| Feature | Rationale for Deferral | Design Status |
| --- | --- | --- |
| **Post-merge auto-pull hook** (`blobsy pull` after `git pull`) | Pull has unbounded cost (network, disk) and not every user needs all blobs immediately — unlike push, where skipping causes data loss for other users (see `blobsy hooks`). Git LFS uses smudge filters for transparent download, not hooks. A hook-based approach is unreliable (fails silently on network errors, no retry). Keep `blobsy pull` explicit for V1. | Investigated; see notes below |
| **Garbage collection** (`blobsy gc`) | Complex safety requirements; V1 doesn’t generate much orphaned data | Fully designed (see GC section) |
| **Branch-isolated mode** (`{git_branch}` variable) | Unclear user demand; adds complexity | Fully designed (see template variables) |
| **Remote checksum storage** (`.bref` `remote_checksum` field) | V1 content-hash sufficient for integrity; ETags are optimization | Format reserved (forward-compatible) |

**Post-merge auto-pull notes:** Git LFS installs a `post-merge` hook but only for file
locking, not for blob download.
LFS achieves transparent download via the git smudge filter mechanism (`.gitattributes`
filter driver that converts pointer files to real content on checkout).
Blobsy intentionally uses visible `.bref` files rather than transparent filter drivers,
so the smudge approach doesn’t directly apply.
If user demand warrants it, a `post-merge` hook could run `blobsy pull --quiet` as a
best-effort convenience, but failures should be non-blocking (log a warning, don’t fail
the merge).

### Explicitly Won’t Do (Design Decisions)

| Feature | Reason Not Implemented |
| --- | --- |
| **Nested .bref files** (ref-to-ref indirection) | Adds complexity; no clear use case |
| **Blob versioning** (multiple versions of same blob) | Git already provides versioning; redundant |
| **Partial blob download** (range requests) | Incompatible with hash verification; users should externalize smaller files |
| **Automatic gitignore removal** (when untracking) | Too risky; users may have manual gitignore entries |
| **In-repo blob encryption** | Cloud provider encryption sufficient; key management adds complexity |

**Rationale Sources:**
- See [issues-history.md](issues-history.md) for detailed rationale and review
  discussions
- V1.1 timeline based on implementation complexity estimates
- V2 features dependent on user feedback and demand signals

## Review Issues Resolution

See [issues-history.md](issues-history.md) for the full mapping of design review issues
to their resolution in this design.
