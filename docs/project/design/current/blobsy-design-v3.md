# blobsy: Large Object Storage for Git Repos (V3 Consolidated Design)

**Status:** Draft

**Date:** 2026-02-21

**Supersedes:** [blobsy-design-v2.md](blobsy-design-v2.md),
[blobsy-design.md](blobsy-design.md) (original comprehensive design), and
[blobsy-git-manifest-alt-design.md](blobsy-git-manifest-alt-design.md) (per-file ref
architecture). Those documents remain in place for reference.

**Companion documents:**

- [stat-cache-design.md](stat-cache-design.md) -- stat cache entry format, storage
  layout, three-way merge algorithm, cache update rules, and recovery
- [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) --
  three-layer defense: pre-commit hook, stat cache detection, attribution

A standalone CLI for per-file sync of large files between local gitignored paths and
remote storage, with committed `.yref` pointer files for tracking.
Git is the manifest.

## Goals and Principles

1. **Simple:** Simple usage is easy.
   `blobsy track`, `blobsy push`, `blobsy pull`. No configuration required beyond a
   backend URL.

2. **CLI only:** No daemon, no server, no GUI. Pure stateless CLI that reads ref files,
   does work, exits.

3. **Self-documenting:** Humans and agents learn to use it by running it.
   Every `.yref` file has a header comment explaining what it is and how to get help.
   Rich `--help` on every command.
   `--json` output for agents.
   Works well as a skill in agent toolchains.

4. **Customizable with sensible defaults:** Hierarchical config at file, directory,
   repo, and home folder levels.
   Zero config needed for common cases; full control available when needed.

5. **Flexible:** Works with any file types, any directory structures.
   No renaming of files or directories.
   Just gitignore the target and put a `.yref` file next to it.
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
| Manifest / file tracking | Git (`.yref` files are git-versioned) | Creates and updates `.yref` files |
| Conflict resolution | Git (standard merge on `.yref` files) | Detects payload-vs-ref desync (see [stat cache](stat-cache-design.md)); git handles `.yref` merges |
| File transfer | External CLI tools (`aws-cli`, `rclone`) or template commands | Orchestrates concurrency |
| Storage | Cloud providers (S3, GCS, Azure, etc.) | Constructs keys, issues commands |
| Compression | Node.js built-in `node:zlib` (`zstd`, `gzip`, `brotli`) | Decides what to compress, applies rules |
| History / versioning | Git (commit history of `.yref` files) | Nothing -- git handles it |

8. **Infrastructure neutral:** Pluggable backend (S3, R2, local, custom command),
   configurable transfer tools (aws-cli, rclone, or arbitrary template commands).
   Compression via Node.js built-in zstd (V1).

9. **One primitive:** The entire system reduces to: one file, one `.yref`, one blob.
   Directories, sync, conflicts, GC -- all follow from this.
   There is no second kind of thing.

10. **Unopinionated where it doesn’t matter:** Blobsy doesn’t care what compression you
    use or which transfer tool you prefer.
    It cares about the contract: a `.yref` file points to a blob, and the blob must be
    reachable. Everything else is pluggable.

11. **Deterministic by design:** Blobsy operations are predictable and reproducible.
    Same content produces same hash.
    Same configuration produces same remote keys.
    `.yref` files use stable field ordering to minimize git diff noise.
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
[stat-cache-design.md](stat-cache-design.md)), which is machine-local and gitignored.

This simplicity means blobsy works in any environment (containers, CI runners, remote
shells) without setup, and never has stale state from a crashed daemon.

### Transparent Testing via Local Backend

The `local` backend (`type: local`, `path: /some/dir/`) makes the entire system testable
without cloud credentials.
Integration tests use a temp directory as the “remote” -- push writes files there, pull
reads them back. Every code path (compression, hashing, atomic writes, conflict
detection) exercises identically to production S3 usage, just with a filesystem
destination.

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

See the [Testing](#testing) section for the specific error scenario test cases and
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

### The `.yref` Convention

For every tracked file, a `.yref` ref file sits adjacent to it with the same name plus
`.yref` appended:

```
data/bigfile.zip           <- actual file (gitignored)
data/bigfile.zip.yref       <- ref file (committed to git)
```

The `.yref` file is committed to git.
The actual data is gitignored.
`blobsy` manages `.gitignore` entries automatically.

**That’s the whole system.** There is no directory type, no manifest, no remote
coordination state. Git tracks `.yref` files.
The remote is a dumb blob store.

### Directories Are Just Recursion

To track a directory, you track every file in it:

```
data/research/                          <- directory (gitignored files within)
data/research/report.md.yref             <- ref (committed)
data/research/raw/response.json.yref     <- ref (committed)
data/research/raw/data.parquet.yref      <- ref (committed)
```

`blobsy track data/research/` creates a `.yref` for every file that meets the
externalization rules, recursively.
Each `.yref` is independent.
Git diffs, merges, and conflicts work per-file, naturally.

### Remote Storage Layouts

Blobsy uses **configurable key templates** to determine where blobs are stored in the
remote. The template is evaluated for each file to compute its remote key, which is then
stored in the `.yref` file.

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
| `{git_branch}` (V2) | Current git branch | `main`, `feature/x` |
| `{compress_suffix}` | Compression suffix based on algorithm | `.zst`, `.gz`, `.br`, or empty string |

Any text outside `{...}` is kept as-is (literal prefix/suffix).

**Note on `{content_sha256_short}`:** Uses the first 12 hex characters of SHA-256 (48
bits of entropy). Collision probability is negligible for typical use (birthday paradox:
~1% chance after ~2.4 million files, ~50% chance after ~17 million files).

**Note on `{iso_date_secs}`:** Format is `YYYYMMDDTHHMMSSZ` (e.g., `20260220T140322Z`).
All punctuation removed for cleaner keys.
Second resolution allows deduplication of identical content pushed in the same second to
the same path (all three must match: timestamp, content hash, and path).

**Note on `{compress_suffix}`:** Automatically set based on compression configuration.
V1 defaults to `.zst` (zstd) or empty string (no compression).
This ensures compressed and uncompressed versions of the same file don’t collide.

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
    type: s3
    bucket: my-datasets
    prefix: project-alpha/
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

##### Pattern 3: Branch-Isolated Storage (V2)

**Separate namespaces per branch, with dedup within each branch.**

**Note:** The `{git_branch}` template variable and branch-isolated storage are deferred
to V2. V1 supports timestamp+hash (Pattern 1), pure CAS (Pattern 2), and shared storage
(Pattern 4) only.

```yaml
# .blobsy.yml
backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: project-alpha/
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
- Feature branch `.yref` files are now on main
- They still point to `feature/new-model/sha256/...` keys (stored in `.yref`)
- Those blobs remain accessible until GC runs
- Optional: Re-push on main to migrate blobs to `main/sha256/...` namespace

**Use when:** You want clear separation between branches, or are working with
experimental/temporary branches that should be cleanly removed.

##### Pattern 4: Global Shared Backing Store

**Single flat namespace, last-write-wins semantics (like rsync or network drives).**

```yaml
# .blobsy.yml
backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: project-alpha/
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
| **Age-based cleanup (V2)** | Easier (GC by date prefix) | Requires full scan | Requires full scan | Requires filtering |
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

1. **On `blobsy track`:** Compute hash, create `.yref` with `hash` and `size` (no remote
   key yet)
2. **On `blobsy push`:**
   - Evaluate `key_template` for each file with current context (branch, path, hash,
     etc.)
   - Compute full key: `{bucket}/{prefix}/{evaluated_template}`
   - Upload to the computed key
   - Store the **actual evaluated key** in `.yref`’s `remote_key` field
   - User commits `.yref` to git
3. **On `blobsy pull`:**
   - Read `remote_key` from `.yref`
   - Fetch from that exact key
4. **On `blobsy gc`:**
   - Collect all `remote_key` values from all `.yref` files in all reachable
     branches/tags
   - List remote objects
   - Delete objects whose key isn’t in the referenced set

**Important:** The `key_template` must be consistent across all users (set in the
committed `.blobsy.yml`). If users have different templates, they’ll push to different
keys and break sync.

## Ref File Format

Every `.yref` file starts with a self-documenting comment header, followed by YAML. Ref
files use stable key ordering (keys are always written in the order shown below) to
minimize noise in `git diff`.

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_key: sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
```

Fields:

| Field | Type | Description |
| --- | --- | --- |
| `format` | string | Format version (`blobsy-yref/0.1`) |
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
(e.g., `blobsy-yref/0.1`). Compatibility policy: reject if major version is unsupported;
warn if minor version is newer than the running blobsy version supports.

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

When a file is compressed before upload, the `.yref` records this:

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
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

Alternatively, compression state is recorded in the `.yref` and blobsy handles the
suffix automatically when constructing the final remote key during upload/download.

## File State Model

Every tracked file has three independent states that determine what actions are needed.
Blobsy uses a clear symbol system to show these states at a glance.

### Three Orthogonal States

For every tracked file:

1. **Tracked:** Does a `.yref` file exist in the working tree?
2. **Synced:** Does the remote blob exist (indicated by `remote_key` being set)?
3. **Committed:** Is the `.yref` file committed to git HEAD?

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

**Tracked:** `.yref` file exists in working tree.

**Synced:**
- `.yref` has `remote_key` field set (not empty)
- Optionally verified: remote blob actually exists at that key

**Committed:**
```bash
# Compare working tree .yref to HEAD
git show HEAD:path/to/file.yref 2>/dev/null | diff - path/to/file.yref
# No diff = committed, diff = not committed
```

**Modified:** Local file hash ≠ `.yref` hash field.

**Missing:** `.yref` exists but local file doesn’t exist.

**Staged for deletion:** `.yref` in `.blobsy/trash/`, not in working tree.

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
$ git add data/model.bin.yref && git commit -m "Track model"
✓ data/model.bin (committed and synced)
```

**Alternative workflow (commit first):**

```bash
# 1. Track
$ blobsy track data/model.bin
○ data/model.bin (not committed, not synced)

# 2. Commit first
$ git add data/model.bin.yref && git commit -m "Track model"
◐ data/model.bin (committed, not synced)

# 3. Push (updates remote_key in working tree)
$ blobsy push
◑ data/model.bin (not committed, synced)
Note: Updated remote_key in 1 .yref file

# 4. Commit the remote_key update
$ git commit -am "Update remote_key after push"
✓ data/model.bin (committed and synced)
```

### Working Tree vs HEAD Semantics

Different commands read from different git states:

| Command | Reads .yref from | Can operate on uncommitted refs? | Modifies .yref? |
| --- | --- | --- | --- |
| `blobsy track` | Working tree | Yes | Yes (updates hash/size) |
| `blobsy push` | Working tree | Yes (with warning) | Yes (sets remote_key) |
| `blobsy pull` | Working tree | Yes (with warning) | No |
| `blobsy sync` | Working tree | Yes (with warning) | Yes (sets remote_key if pushing) |
| `blobsy status` | Both (working tree + HEAD) | Yes | No |
| `blobsy verify` | Working tree | Yes | No |
| `blobsy gc` (V2) | HEAD (all branches/tags) | N/A | No |

**Key principle:** Commands read from **working tree** for current state, compare to
**HEAD** to determine if committed.

**GC is special (V2):** It reads from HEAD across all branches/tags to determine which
remote blobs are referenced.

### Warnings for Uncommitted Refs

Commands that modify `.yref` files warn when they’re uncommitted:

```bash
$ blobsy push
Warning: Operating on 2 uncommitted .yref files:
  data/model.bin.yref (new)
  results/output.json.yref (modified)

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
| **Change detection** | Has this file changed since last sync? | SHA-256 hash in `.yref` vs local file hash |
| **At-rest verification** | Does this local file match what was pushed? | SHA-256 in `.yref` (`blobsy verify`) |

**Transfer integrity** is handled by the transport layer.
S3 verifies uploads via ETags and supports `x-amz-checksum-sha256` natively.
`aws s3 sync` and `rclone` verify transfers internally.
Blobsy does not re-implement transfer verification.

**Change detection** uses SHA-256 hashes in the `.yref` file.
Every tracked file has its hash in its own `.yref`. This enables accurate change
detection independent of mtime (which `git checkout` doesn’t preserve), and clear signal
in `git diff` when data actually changed.

**At-rest verification** via `blobsy verify`: hash each local file, compare against the
`.yref`’s `hash`, report mismatches.
Works for all tracked files, fully offline.

### Why SHA-256 Over Provider-Native Hashes

Cloud storage providers each compute their own checksums, but the landscape is too
fragmented to rely on.
AWS S3 auto-computes CRC64NVME, GCS uses CRC32C, Azure uses MD5 (only for small
uploads), Backblaze uses SHA-1, and R2/Wasabi/Tigris use MD5 ETags for non-multipart
uploads only. Multipart uploads produce composite checksums on most providers that don’t
match a simple hash of the whole file.

Computing SHA-256 independently and storing it in `.yref` files is the only portable
approach that works consistently across all providers.

When using the built-in SDK, blobsy can provide `x-amz-checksum-sha256` with the upload
and S3 verifies server-side -- but this uses the same SHA-256 blobsy already computes,
not an additional algorithm.

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
   sync (distinguishes “git pull updated .yref” from “user modified file”).

The stat cache is **mandatory** for operations that modify `.yref` files (`track`,
`push`, `pull`, `sync`) and optional for read-only operations (`status`, `verify`).

Uses file-per-entry storage (one JSON file per tracked file) with atomic writes to
eliminate concurrent-write conflicts between parallel blobsy processes.

See [stat-cache-design.md](stat-cache-design.md) for full design: entry format, storage
layout, API, three-way merge algorithm, cache update rules, and recovery.

### Future: Remote Staleness Detection via Provider Hashes

One optimization for a future version: after a successful push, blobsy could store the
provider’s response hash (e.g., ETag, `x-amz-checksum-crc64nvme`) alongside the
`remote_key` in the `.yref`. This enables cheap remote staleness detection: a
`HeadObject` request returns the current provider hash, and if it matches the stored
value, the remote file hasn’t changed since last push -- without downloading or
re-hashing.

This is not needed for V1 -- SHA-256 hashes in `.yref` files handle all verification
needs.

## CLI Commands

### Path Specifications

All blobsy commands that operate on files accept flexible path specifications:

**Accepted path formats:**

1. **Original file path:** `data/model.bin`
2. **Ref file path:** `data/model.bin.yref` (equivalent to #1)
3. **Directory path:** `data/research/` (behavior depends on command)

**Path resolution:**

- When you specify `data/model.bin.yref`, blobsy treats it as `data/model.bin`
- Both forms are accepted and produce identical results
- This allows tab-completion to work naturally (completing to `.yref` files works)

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
# These are equivalent (file path vs .yref path)
blobsy track data/model.bin
blobsy track data/model.bin.yref

# Directory operations
blobsy track data/research/              # Tracks all eligible files (recursive)
blobsy status data/research/              # Shows status of tracked files in directory
blobsy untrack --recursive data/old/      # Requires --recursive flag
blobsy rm --recursive data/experiments/   # Requires --recursive flag

# Path omitted = operate on entire repo
blobsy status        # All tracked files in repo
blobsy sync          # All tracked files in repo
```

**No glob patterns in V1:**

Glob expansion (e.g., `data/*.bin`) is handled by your shell, not by blobsy.
Use shell globs or pass explicit paths.

```bash
# Shell expands the glob
blobsy track data/*.bin

# Or use find
find data -name "*.bin" -exec blobsy track {} +
```

### `blobsy init`

Initialize blobsy in a git repo.

```bash
$ blobsy init
Created .blobsy.yml
? Bucket: my-datasets
? Region: us-east-1
```

Interactive when run without flags.
Supports fully non-interactive usage via flags:
`blobsy init --bucket my-data --region us-east-1`.

Also installs a pre-commit hook that auto-pushes blobs when committing `.yref` files.
See [Conflict Detection](#conflict-detection) and `blobsy hooks` below.

### `blobsy track`

Start tracking a file or directory with blobsy.

```bash
# Single file -- always externalizes, regardless of size rules
$ blobsy track data/bigfile.zip
Tracking data/bigfile.zip
Created data/bigfile.zip.yref
Added data/bigfile.zip to .gitignore

# Directory -- applies externalization rules to decide per-file
$ blobsy track data/research/
Scanning data/research/...
  data/research/report.md          (12 KB, .md)    -> kept in git
  data/research/config.yaml        (800 B, .yaml)  -> kept in git
  data/research/model.bin          (500 MB, .bin)   -> externalized (.yref)
  data/research/raw/metadata.txt   (500 B, .txt)   -> kept in git
  data/research/raw/data.parquet   (50 MB, .parquet) -> externalized (.yref)
2 files tracked, 3 kept in git.
```

**Key distinction:**

- **Explicit file** (`blobsy track data/bigfile.zip`): always externalizes.
  You named the file -- that’s explicit intent.
- **Directory** (`blobsy track data/research/`): applies the `externalize` rules from
  `.blobsy.yml` (size threshold, always/never patterns) to decide per-file.

What it does:

1. For each file to externalize: compute SHA-256, create a `.yref` adjacent to the file,
   add the original file to `.gitignore`.
2. For directories: skip files that don’t meet the externalization rules (they stay in
   git as normal files).
3. Skip files matching `ignore` patterns.

The `.yref` files are not yet git committed.
The user does that:

```bash
$ git add data/bigfile.zip.yref
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
Updated data/research/model.bin.yref (hash changed)

# Or refresh all tracked files in a directory
$ blobsy track data/research/
Updated data/research/model.bin.yref (hash changed)
1 file updated, 1 unchanged.
```

### `blobsy untrack`

Stop tracking a file or directory (keeps local file).

```bash
$ blobsy untrack data/bigfile.zip
Untracked data/bigfile.zip
Moved data/bigfile.zip.yref -> .blobsy/trash/data/bigfile.zip.yref
Removed data/bigfile.zip from .gitignore
(Local file preserved)
```

**Directory untracking (requires `--recursive`):**

```bash
$ blobsy untrack --recursive data/research/
Untracked 2 files in data/research/
Moved data/research/model.bin.yref -> .blobsy/trash/data/research/model.bin.yref
Moved data/research/raw/data.parquet.yref -> .blobsy/trash/data/research/raw/data.parquet.yref
Removed 2 entries from .gitignore
(Local files preserved)
```

**Path specifications:**

Both the original file path and `.yref` path are accepted:

```bash
blobsy untrack data/model.bin        # Works
blobsy untrack data/model.bin.yref   # Also works (same result)
```

**What it does:**

1. Move each `.yref` to `.blobsy/trash/` (preserving the path structure).
2. Remove the gitignore entry.
3. Leave local files and remote blobs untouched.

**Flags:**

| Flag | Effect |
| --- | --- |
| `--recursive` | Required for directory removal |

The user then `git add` + `git commit` to finalize.
The trash gives `blobsy gc` (V2 feature) a record of which remote blobs were once
referenced.

### `blobsy rm`

Remove files from blobsy tracking and delete the local file.

**Default behavior (deletes local file):**

```bash
$ blobsy rm data/old-model.bin
⊗ data/old-model.bin (staged for deletion)

Moved data/old-model.bin.yref -> .blobsy/trash/data/old-model.bin.yref
Removed data/old-model.bin from .gitignore
Deleted local file: data/old-model.bin (500 MB freed)

Next: Run 'git add -A && git commit -m "Remove old-model.bin"'
```

**With `--local` flag (delete local file only, keep .yref and remote):**

```bash
$ blobsy rm --local data/large-dataset.parquet
? data/large-dataset.parquet (file missing)

Deleted local file: data/large-dataset.parquet (2.5 GB freed)
Kept .yref and remote blob (run 'blobsy pull' to restore)

Use case: Free up local disk space while keeping the file tracked and synced.
```

**Directory removal (requires `--recursive`):**

```bash
$ blobsy rm --recursive data/old-experiments/
Staged for removal (3 files):
  ⊗ data/old-experiments/model-v1.bin
  ⊗ data/old-experiments/model-v2.bin
  ⊗ data/old-experiments/results.csv

Moved 3 .yref files to .blobsy/trash/
Removed 3 entries from .gitignore
Deleted 3 local files (1.2 GB freed)
```

**Path specifications:**

Both the original file path and `.yref` path are accepted:

```bash
blobsy rm data/model.bin        # Works
blobsy rm data/model.bin.yref   # Also works (same result)
```

**Flags:**

| Flag | Effect |
| --- | --- |
| (none) | Move .yref to trash, remove from .gitignore, delete local file |
| `--local` | Delete local file only, keep .yref and remote blob (useful for freeing disk space) |
| `--recursive` | Required for directory removal |

**What it does:**

1. Default: Move `.yref` to `.blobsy/trash/`, remove from `.gitignore`, delete local
   file
2. `--local`: Only delete local file (keep tracking and remote)
3. Remote blobs always left untouched (GC removes them later, see V2 features)

**Difference from `blobsy untrack`:**
- `blobsy rm`: Deletes local file + stops tracking (permanent removal)
- `blobsy untrack`: Stops tracking, keeps local file (you want to manage it yourself)

**Note on trash command (V2):** The `blobsy trash` command (as a safer alternative to
`rm` that moves files to a trash directory before deletion) is deferred to V2. V1 only
provides `blobsy rm` for removing tracked files.

### `blobsy mv` (V1)

Rename or move a tracked file.
This fixes a critical gap: `git mv` only moves the `.yref` but leaves the payload at the
old location, causing constant drift.

**V1 behavior (files only):**

```bash
$ blobsy mv data/model-v1.bin data/model-v2.bin
Moved: data/model-v1.bin → data/model-v2.bin
Moved: data/model-v1.bin.yref → data/model-v2.bin.yref
Updated .gitignore (removed old entry, added new entry)

Next: Run 'git add -A && git commit -m "Rename model"'
```

**Path specifications:**

Both the original file path and `.yref` path are accepted:

```bash
blobsy mv data/old.bin data/new.bin        # Works
blobsy mv data/old.bin.yref data/new.bin   # Also works (same result)
```

**What it does:**

1. Verify source is tracked (has `.yref`)
2. Verify dest doesn’t already exist (neither file nor `.yref`)
3. Move local payload: `source → dest`
4. Move ref file: `source.yref → dest.yref`
5. Update `.gitignore` (remove source entry, add dest entry)
6. Preserve `remote_key` in the `.yref` (no re-upload needed)

**Key design decision:** V1 always preserves the `remote_key`. Rationale:

- Content hasn’t changed → no need to re-upload
- Avoids orphaning blobs at old keys
- Simpler implementation
- Works correctly for pure content-addressable templates
- For path-based templates, the old path is “frozen” in the remote key (acceptable
  tradeoff for V1)

**Multi-user workflow:**

```bash
# User A renames a file
$ blobsy mv data/model-v1.bin data/model-v2.bin
$ git add -A
$ git commit -m "Rename model-v1 to model-v2"
$ git push

# User B pulls the changes
$ git pull
# .yref renamed but payload still at old location

$ blobsy status
⚠ data/model-v2.bin.yref points to missing file
  Expected: data/model-v2.bin
  Found: data/model-v1.bin (at old location)
  Run: blobsy mv data/model-v1.bin data/model-v2.bin

$ blobsy mv data/model-v1.bin data/model-v2.bin
# Now in sync
```

**V1 limitations (deferred to V2):**

- No directory moves (only individual files)
- No `--new-key` flag (always preserves `remote_key`)
- No automatic move detection on `blobsy pull`

**V2 enhancements:**

| Feature | Description |
| --- | --- |
| `blobsy mv --new-key` | Regenerate `remote_key` based on new path (requires re-upload) |
| `blobsy mv dir1/ dir2/` | Recursive directory moves (implemented on top of V1 file move) |
| Auto-detection | `blobsy pull` detects moved `.yref` files and fixes payload paths automatically |

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

Reminder: 2 .yref files have uncommitted changes. Run 'git add -A && git commit' to commit.
```

**Reads from:** Working tree `.yref` files (can operate on uncommitted refs with
warnings).

**Algorithm:**

1. **Health check** (first, before processing any files):
   - Verify backend is accessible and credentials are valid
   - Fail fast with clear error if backend is unreachable
   - Skip with `--skip-health-check` flag (advanced use)
   - See [Transport Health Check](#transport-health-check) section

2. **For each `.yref` file**, apply the three-way merge algorithm using the stat cache
   as merge base. See [stat-cache-design.md](stat-cache-design.md) for the full decision
   table and per-file sync logic.

   Summary:
   - **Local matches cache, .yref matches cache** -- up to date
   - **Local matches cache, .yref differs** -- git pull updated .yref, pull new blob
   - **Local differs from cache, .yref matches cache** -- user modified file, push
   - **Both differ** -- conflict, error with resolution options
   - **Local file missing** -- pull from remote (or error if remote also missing)

**Important:** Sync can modify `.yref` files (update hash, set `remote_key`). These
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
matches the `.yref` hash.
If the file was modified after `blobsy track`, the push fails with a helpful error.
Use `--force` to override (updates `.yref` to match current file, then pushes).
See [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) for
full push verification logic.

**Pull behavior on local modifications:** If a local file has been modified (hash
differs from both ref and remote), pull fails with exit code 2. Use `--force` to
overwrite local modifications.

Pull does not delete local files.
Extra local files not referenced by any `.yref` are left untouched.

### `blobsy status`

Show the state of all tracked files.
**Fully offline.**

```bash
$ blobsy status
  data/bigfile.zip              ok (500 MB)
  data/research/report.md       modified (local != ref) (12 KB)
  data/research/raw/resp.json   missing locally (1.2 MB)
  data/research/raw/data.parq   ok (not pushed) (45 MB)
```

What it does:

1. Find all `.yref` files in the repo.
2. For each, compare local file hash against the ref’s `hash`.
3. Report: ok, modified, missing, not pushed (no `remote_key`).
4. Show human-readable file sizes from `.yref` metadata.

No network access. The ref file has everything needed.

**V2 enhancement:** File sizes shown in human-readable format (KB, MB, GB) for all
tracked files. Sizes are read from `.yref` metadata, so this remains fully offline.

### `blobsy stats`

Show aggregate statistics across all tracked files.
**Fully offline.**

```bash
$ blobsy stats

Repository: /Users/alice/projects/ml-research
Backend: s3 (bucket: my-datasets, prefix: ml-research/)

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

1. Scan all `.yref` files in the repository.
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

**V2 feature:** First introduced in V2. Complements `blobsy status` (per-file detail)
with aggregate rollup view.

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
**V2 enhancement:** Expanded to include common error detection, troubleshooting advice,
and integration validation.

```bash
$ blobsy doctor

=== CONFIGURATION ===
Backend: s3 (bucket: my-datasets, prefix: project-v1/, region: us-east-1)
Key template: {iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}
Remote layout: Timestamp+Hash (default, recommended)

Sync tools:
  ✓ aws-cli v2.13.5 (detected at /usr/local/bin/aws)
  ✗ rclone (not found)
  → Using: aws-cli

Compression: zstd (via Node.js built-in)
Externalization threshold: 1 MB (files below this stay in git)

=== REPOSITORY STATE ===
Git repository: /Users/alice/projects/ml-research
Branch: main (clean working tree)

Tracked files: 18 total (5.1 GB)
  ✓ 8 fully synced (2.1 GB)
  ◐ 3 committed, not synced (1.2 GB)
  ~ 2 modified locally (850 MB)
  ? 1 missing locally (120 MB)

Stat cache: 18 entries, 0 stale, 245 KB
Trash: 3 expired refs (last GC: never)

=== GIT HOOKS ===
✓ pre-commit hook installed (.git/hooks/pre-commit)
  Purpose: Auto-push blobs when committing .yref files

=== CONNECTIVITY ===
✓ Backend reachable (s3://my-datasets/project-v1/)
✓ Credentials valid (AWS profile: default)
✓ Test upload: ok (wrote + deleted 1 KB test object)

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✓ No .yref files missing corresponding .gitignore entries
⚠ 2 files modified locally (hash mismatch with .yref)
  → Run 'blobsy track <path>' to update refs

=== COMMON ISSUES ===
No issues detected.

=== TROUBLESHOOTING TIPS ===
• Modified files: Run 'blobsy track <path>' to update .yref after changes
• Missing files: Run 'blobsy pull <path>' to restore from remote
• Uncommitted refs: Run 'git add -A && git commit' after track/push
• Sync failures: Check 'blobsy doctor' for credential/connectivity issues
• Large gitignore: Normal (1 line per tracked file in blobsy-managed block)

For detailed help: https://github.com/jlevy/blobsy/docs
```

**V1 behavior:** Basic configuration and connectivity checks.

**V2 enhancements:**
1. **Comprehensive state overview** - Includes stats rollup (superset of `blobsy stats`)
2. **Common error detection** - Detects and reports common configuration mistakes:
   - Missing `.gitignore` entries for tracked files
   - Orphaned `.gitignore` entries (file no longer tracked)
   - Invalid `.yref` files (malformed YAML, unsupported format version)
   - Uncommitted refs after push (common mistake)
   - Modified files not re-tracked
   - Stale stat cache entries
   - Missing pre-commit hook (recommends `blobsy hooks install`)
   - Credential expiration warnings
3. **Troubleshooting advice** - Context-aware suggestions based on detected issues:
   - How to fix each detected problem
   - Links to relevant documentation sections
   - Common workflows that might have caused the issue
4. **Integration validation** - Verifies all components work together:
   - Test upload/download to backend
   - Compression library availability
   - Transfer tool version compatibility
   - Git repository health (no corruption)
   - `.blobsy/` directory structure valid
5. **Extensible diagnostics** - New checks added as common errors are discovered in the
   field

**Flags:**
- `--fix` - Attempt to automatically fix detected issues (safe repairs only):
  - Add missing `.gitignore` entries
  - Remove orphaned `.gitignore` entries
  - Clean up stale stat cache entries
  - Install missing pre-commit hook
  - Remove orphaned temp files (`.blobsy-tmp-*`)
- `--verbose` - Show detailed diagnostic logs (useful for bug reports)
- `--json` - Machine-readable output for scripting

**Exit codes:**
- `0` - All checks passed
- `1` - Warnings detected (repo functional but suboptimal)
- `2` - Errors detected (action required before sync operations)

### `blobsy config`

Get or set configuration values:

```bash
$ blobsy config [key] [value]    # get/set
$ blobsy config backend          # show current backend
```

### `blobsy hooks`

Manage the pre-commit hook that auto-pushes blobs when committing `.yref` files.

```bash
$ blobsy hooks install
✓ Installed pre-commit hook (.git/hooks/pre-commit)

$ blobsy hooks uninstall
✓ Removed pre-commit hook
```

Installed automatically by `blobsy init`. To bypass the hook for a specific commit:

```bash
$ git commit --no-verify
```

See [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) for
hook implementation details and the full pre-commit script.

### `blobsy check-unpushed`

Find committed `.yref` files whose blobs are missing from remote storage.

```bash
$ blobsy check-unpushed

⚠ Found 2 .yref files in HEAD with missing remote blobs:

  data/model.bin.yref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Issue: remote_key not set (never pushed)

To fix: Run 'blobsy push' to upload missing blobs.
```

Uses git blame to identify who committed each problematic `.yref`. Diagnostic tool for
when team members report “missing (no remote!)” errors.

**Flags:**
- `--json` - Machine-readable output

### `blobsy pre-push-check`

Verify all committed `.yref` files have reachable remote blobs.
CI-friendly.

```bash
$ blobsy pre-push-check

✓ All committed .yref files have remote blobs
  Checked 15 .yref files in HEAD
```

**Exit codes:**
- `0` - All `.yref` files have blobs
- `1` - One or more `.yref` files missing blobs

**Use case:** Run in CI before allowing merge to prevent commits with missing blobs from
entering the main branch.

### Command Summary

```
SETUP
  blobsy init                          Initialize blobsy in a git repo
  blobsy config [key] [value]          Get/set configuration
  blobsy health                        Check transport backend health (credentials, connectivity)
  blobsy doctor                        Comprehensive diagnostics and health check (V2: enhanced)
       [--fix]                       Auto-fix detected issues
  blobsy hooks install|uninstall       Manage pre-commit hook (auto-push on commit)

TRACKING
  blobsy track <path>...               Start tracking a file or directory (creates/updates .yref)
  blobsy untrack [--recursive] <path>  Stop tracking, keep local file (move .yref to trash)
  blobsy rm [--local|--recursive] <path>  Remove from tracking and delete local file
  blobsy mv <source> <dest>            Rename/move tracked file (V1: files only, preserves remote_key)

SYNC
  blobsy sync [path...]                Bidirectional: track changes, push missing, pull missing
  blobsy push [path...]                Upload local blobs to remote, set remote_key
       [--force]                     Override hash mismatch (updates .yref to match file)
  blobsy pull [path...]                Download remote blobs to local
       [--force]                     Overwrite local modifications
  blobsy status [path...]              Show state of all tracked files (○ ◐ ◑ ✓ ~ ? ⊗) (V2: with sizes)
  blobsy stats                         Show aggregate statistics by state (V2: new command)
  blobsy check-unpushed                Find committed .yref files with missing remote blobs
  blobsy pre-push-check                Verify all .yref files have remote blobs (for CI)

VERIFICATION
  blobsy verify [path...]              Verify local files match ref hashes
```

### Flags (Global)

```
--json          Structured JSON output (for agents and scripts)
--quiet         Suppress all output except errors
--dry-run       Show what would happen without doing it
--verbose       Detailed progress output
--force         Skip confirmation for destructive operations
--help          Command help with usage examples
```

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

When `blobsy track <dir>` runs, it decides which files get externalized (`.yref` +
gitignored) vs. left alone (committed directly to git).
The decision is based on **size** and **file type**:

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
    type: s3
    bucket: my-datasets
    prefix: project-v1/          # global prefix for all blobs
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
    type: s3
    bucket: my-datasets
    prefix: my-project/
    region: us-east-1

remote:
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"  # default (timestamp+hash)

externalize:
  min_size: 1mb

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

### Backend Types

**`s3`:** Any S3-compatible store.
This single type covers AWS S3, Cloudflare R2, MinIO, Backblaze B2, Tigris, DigitalOcean
Spaces, and others.
R2 and other S3-compatible stores are configured as `type: s3` with a
custom `endpoint`.

**`local`:** Directory-to-directory copy.
For development and testing.
No cloud account needed.

**`command`:** Arbitrary shell commands for push/pull.
This serves two purposes:

1. **Escape hatch** for unsupported backends (SCP, rsync, custom APIs).
2. **Template-based transfer layer** -- a powerful alternative to named tools.
   Because each command template runs once per file with variable expansion, a `command`
   backend is functionally equivalent to a custom transfer tool.

Template variables:

- `{local}` -- absolute path to the local file.
- `{remote}` -- full remote key (e.g., `sha256/7a3f0e.../data/prices.parquet`).
- `{relative_path}` -- repo-relative path of the tracked file (e.g.,
  `data/prices.parquet`).
- `{bucket}` -- the configured bucket name.

The command runs once per file (not once per push operation), with up to `sync.parallel`
invocations running concurrently.

**Error handling:**
- **Exit code 0:** Success - file transferred successfully
- **Non-zero exit code:** Failure - file transfer failed

On failure, blobsy captures **both stdout and stderr** from the command and displays
them to the user with context (file path, command, exit code).
Transport tools vary in where they write error messages -- some use stderr, some use
stdout, some use both.
Blobsy does not discard either stream.

**Examples:**

```yaml
backends:
  # SCP to a remote server
  ssh-server:
    type: command
    push_command: scp {local} myhost:/data/{remote}
    pull_command: scp myhost:/data/{remote} {local}

  # rsync with compression
  rsync-remote:
    type: command
    push_command: rsync -az {local} myhost:/data/{remote}
    pull_command: rsync -az myhost:/data/{remote} {local}

  # curl to a custom HTTP API
  custom-api:
    type: command
    push_command: >-
      curl -sf -X PUT -T {local}
      https://api.example.com/blobs/{remote}
    pull_command: >-
      curl -sf -o {local}
      https://api.example.com/blobs/{remote}

  # aws-cli with custom flags (e.g., specific profile, storage class)
  s3-archive:
    type: command
    push_command: >-
      aws s3 cp {local} s3://my-archive-bucket/{remote}
      --profile archive --storage-class GLACIER_IR
    pull_command: >-
      aws s3 cp s3://my-archive-bucket/{remote} {local}
      --profile archive
```

This design means that even without first-class support for a given transfer tool or
storage backend, a user can integrate it in minutes with a template command.
The `command` backend is sufficient for any tool that can copy a single file given a
source and destination path.

**Security restriction:** `command` backends from repo-level config require explicit
trust. See [Security and Trust Model](#security-and-trust-model).

**Cross-platform limitations:** Command backends run through Node.js `child_process`,
which uses different shells on different platforms (cmd.exe on Windows, /bin/sh on
Unix). For cross-platform compatibility in mixed OS environments, avoid complex shell
pipes, operators, or bash-specific syntax.
Instead, use simple command invocations or prefer named tools (`aws-cli`, `rclone`) that
have cross-platform installers and consistent CLI interfaces.
If shell-specific features are needed, consider maintaining separate `.blobsy.yml` files
with platform-specific commands or using the `s3` backend type with named transfer
tools.

### S3-Compatible Backends

R2, MinIO, Backblaze B2, Tigris, and other S3-compatible stores all use the same
`type: s3` backend with a custom endpoint:

```yaml
backends:
  r2:
    type: s3
    endpoint: https://ACCT_ID.r2.cloudflarestorage.com
    bucket: my-r2-data

  dev:
    type: local
    path: /tmp/blobsy-test-remote/
```

The AWS CLI and rclone support `--endpoint-url` for S3-compatible stores.
`@aws-sdk/client-s3` supports custom endpoints via its client configuration object.

### Transfer Delegation

`blobsy` does not implement high-performance transfers.
It delegates to external CLI tools, trying each in the configured preference order:

| Tool | How transfers work |
| --- | --- |
| `aws-cli` | Shells out to `aws s3 cp` per file |
| `rclone` | Shells out to `rclone copyto` per file |

The `sync.tools` setting is an ordered list (default: `[aws-cli, rclone]`). Blobsy tries
each tool in order, using the first one that passes a capability check.
To force a specific tool, set a single-element list: `sync.tools: [rclone]`. This
setting follows the standard hierarchical config override (user-global < repo <
directory), so a user who prefers rclone can set it globally while repos can override if
needed.

Because blobsy uses content-addressable storage and per-file `.yref` refs, it always
knows exactly which files to transfer.
It uses transfer tools as **copy engines** (per-file `cp`/`copy`), not diff engines.
Blobsy owns the diffing via `.yref` hashes; the transfer tool only moves bytes.

**Tool detection:** Blobsy performs a lightweight capability check (binary exists +
credentials configured + endpoint reachable), not just binary existence.
If aws-cli is installed but not configured for the target endpoint, it falls through to
the next tool in the list.
`blobsy doctor` shows which tool was selected and why.

**Template commands as transfer layer:** For backends that are not S3-compatible, or for
advanced use cases (SCP, custom APIs, proprietary tools), the `command` backend type
doubles as a fully custom transfer layer.
Because the command template runs once per file with `{local}` and `{remote}` variable
expansion, it is functionally equivalent to a transfer tool -- just specified as a
template rather than a named preset.
See [Backend Types](#backend-types) for details.

This means blobsy supports three transfer modes in V1:
1. **Named tools** (`aws-cli`, `rclone`) -- zero-config for S3-compatible backends.
2. **Template commands** (`command` backend) -- arbitrary CLI commands, one per file.
   Works with SCP, rsync, curl, or any tool that can copy a file.
3. **Built-in SDK** (`@aws-sdk/client-s3`) -- fallback when no external tool is
   available. Slower, but zero external dependencies.

### Compression and Transfer Interaction

Compression is handled by blobsy, not by the transfer tool.
The workflow for each file:

**Push:** compress to temp file (if compression applies) -> upload via transfer tool ->
clean up temp file.

**Pull:** download via transfer tool -> decompress from temp file (if compressed) ->
write to final location.

This is file-by-file orchestration.
Blobsy never delegates directory-level `sync` to external tools because the remote
representation (compressed, content-addressed) differs from the local representation
(uncompressed, original paths).

### Symlinks

`blobsy` inherits symlink behavior from the underlying transport tool.
Symlinks are followed on push (the content is uploaded), and regular files are written
on pull (S3 and other object stores have no symlink concept).
Symlink metadata is not preserved across the remote.

### Authentication

No custom auth mechanism.
Uses the standard credential chain for the backend:

- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Shared credentials file (`~/.aws/credentials`)
- Instance profiles / IAM roles
- rclone config (when rclone is selected from `sync.tools`)

### Atomic Writes

**All backends:** Blobsy manages atomic downloads for ALL backends to ensure consistent,
reliable behavior regardless of the underlying transport mechanism.
We do not rely on external tools to handle atomicity.

**Download pattern for all backends:**

1. Download to blobsy-managed temp file (`.blobsy-tmp-*` pattern)
2. Compute SHA-256 hash and verify integrity
3. Atomically rename to final location only after successful verification

**Backend-specific implementation:**

- **Built-in `@aws-sdk` engine:** Blobsy downloads directly to temp file, then renames
- **External tools (aws-cli, rclone):** Blobsy wraps tool invocation to download to temp
  file first, then verifies and renames
- **Command backends:** Blobsy provides `$BLOBSY_TEMP_OUT` environment variable pointing
  to temp file location; user templates write there; blobsy verifies hash and renames on
  exit code 0

**Other atomic operations:** Blobsy also uses temp-file-then-rename for:

- `.yref` file updates
- Stat cache writes (file-per-entry, via `atomically` package)

**Temp file management:**

- Temp files use the pattern `.blobsy-tmp-*` in the same directory as the target file
- `blobsy doctor` reports orphaned temp files
- On startup or via `blobsy clean`, orphaned temp files are removed

**Interrupted operations:** If push or pull is interrupted midway, re-running is safe.
Already-transferred files are detected via hash comparison and skipped.
Per-file atomicity ensures no corrupt partial files.

## Transport Layer Error Handling

When transport commands fail, blobsy provides clear, actionable error messages with full
diagnostic context. This is critical for debugging common issues like authentication
failures, permission errors, and network problems.

### Error Capture

When a transport command fails (non-zero exit code):

1. **Capture both stdout and stderr** from the failed command
2. **Preserve the original error message** from the transport tool
3. **Add context** about which file transfer failed and what command was attempted
4. **Format consistently** across all backends (S3, local, command templates)

**Important:** Both stdout and stderr are captured.
Transport tools vary in where they write error messages -- aws-cli may write JSON errors
to stdout, rclone writes to stderr, custom scripts may use either.
Blobsy does not assume or discard either stream.

### Error Message Format

**Human-readable format (default):**

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 1

Output:
upload failed: s3://my-bucket/sha256/abc123... An error occurred (InvalidAccessKeyId)
when calling the PutObject operation: The AWS Access Key Id you provided does not
exist in our records.

Troubleshooting:
- Check AWS credentials: aws configure list
- Verify bucket access: aws s3 ls s3://my-bucket/
- See: https://github.com/jlevy/blobsy/docs/troubleshooting#auth-errors
```

**JSON format (`--json`):**

```json
{
  "schema_version": "0.1",
  "error": {
    "type": "transport_failure",
    "file": "data/model.bin",
    "size": 524288000,
    "direction": "push",
    "backend": "s3",
    "bucket": "my-bucket",
    "remote_key": "sha256/abc123...",
    "command": "aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...",
    "exit_code": 1,
    "stdout": "upload failed: s3://my-bucket/sha256/abc123...",
    "stderr": "An error occurred (InvalidAccessKeyId) when calling the PutObject operation: The AWS Access Key Id you provided does not exist in our records.",
    "error_category": "authentication",
    "troubleshooting_url": "https://github.com/jlevy/blobsy/docs/troubleshooting#auth-errors"
  }
}
```

### Error Categories

Blobsy attempts to categorize common transport errors for better troubleshooting:

| Category | Detection Patterns | Common Causes |
| --- | --- | --- |
| `authentication` | “InvalidAccessKeyId”, “AccessDenied”, “403”, “Forbidden” | Missing/expired credentials, wrong IAM permissions |
| `not_found` | “NoSuchBucket”, “404”, “Not Found”, “NoSuchKey” | Bucket doesn’t exist, wrong region, blob not found |
| `network` | “Connection refused”, “timeout”, “Name resolution failed” | Network down, DNS issues, firewall blocking |
| `permission` | “Permission denied”, “Access Denied”, “InsufficientPermissions” | IAM policy missing required actions |
| `quota` | “RequestLimitExceeded”, “TooManyRequests”, “429” | Rate limiting, quota exceeded |
| `storage_full` | “No space left”, “QuotaExceeded”, “InsufficientStorage” | Bucket quota exceeded, local disk full |
| `unknown` | (default) | Unrecognized error pattern |

Error categorization is best-effort pattern matching on stdout/stderr.
It enables context-aware troubleshooting suggestions.

### Partial Failure Handling

When syncing multiple files, blobsy continues processing remaining files after a
transport failure:

```bash
$ blobsy push
Pushing 3 files...
  ✓ data/file1.bin (1.2 GB) - ok
  ✗ data/file2.bin (500 MB) - FAILED
  ✓ data/file3.bin (800 MB) - ok

1 file failed (see errors above)
Exit code: 1
```

All errors are collected and displayed at the end.
Exit code is 1 if any file failed.

In `--json` mode, the output includes both successful and failed transfers:

```json
{
  "schema_version": "0.1",
  "summary": {
    "total": 3,
    "succeeded": 2,
    "failed": 1
  },
  "transfers": [
    {"file": "data/file1.bin", "status": "success", "size": 1288490188},
    {
      "file": "data/file2.bin",
      "status": "failed",
      "error": {
        "type": "transport_failure",
        "command": "aws s3 cp ...",
        "exit_code": 1,
        "stdout": "...",
        "stderr": "...",
        "error_category": "authentication"
      }
    },
    {"file": "data/file3.bin", "status": "success", "size": 838860800}
  ]
}
```

### Common Error Scenarios

These scenarios must be tested (see Testing section) and should produce helpful error
messages:

#### Missing AWS Credentials

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 255

Output:
Unable to locate credentials. You can configure credentials by running "aws configure".

Troubleshooting:
- Run: aws configure
- Or set: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
- Or use IAM role (if on EC2/ECS)
- See: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
```

#### Wrong Bucket/Region

```
Error: Failed to pull data/model.bin (500 MB)

Command: aws s3 cp s3://my-bucket/sha256/abc123... /path/to/data/model.bin
Exit code: 1

Output:
fatal error: An error occurred (NoSuchBucket) when calling the HeadObject operation:
The specified bucket does not exist

Troubleshooting:
- Verify bucket name: my-bucket
- Check region: us-east-1 (configured) vs. actual bucket region
- Run: aws s3 ls s3://my-bucket/ --region us-east-1
- Check .blobsy.yml backend configuration
```

#### Permission Denied

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 1

Output:
upload failed: s3://my-bucket/sha256/abc123... An error occurred (AccessDenied) when
calling the PutObject operation: Access Denied

Troubleshooting:
- Your IAM user/role needs s3:PutObject permission on s3://my-bucket/*
- Check IAM policy attached to your credentials
- See: https://github.com/jlevy/blobsy/docs/troubleshooting#iam-permissions
```

#### Network Timeout

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 1

Output:
upload failed: s3://my-bucket/sha256/abc123... Connect timeout on endpoint URL:
"https://my-bucket.s3.amazonaws.com/..."

Troubleshooting:
- Check network connectivity
- Verify firewall/proxy settings
- Try with smaller file first to test connectivity
- Consider increasing timeout: AWS_CLI_CONNECT_TIMEOUT=60
```

#### Disk Full (Local)

```
Error: Failed to pull data/model.bin (500 MB)

Command: aws s3 cp s3://my-bucket/sha256/abc123... /path/to/data/model.bin
Exit code: 1

Output:
download failed: [Errno 28] No space left on device: '/path/to/data/model.bin'

Troubleshooting:
- Free up disk space on local filesystem
- Current usage: df -h /path/to/data
- Consider using blobsy rm --local to remove other tracked files
```

### Transport Health Check

Before starting concurrent file transfers, blobsy runs a lightweight health check to
verify the transport backend is accessible and credentials are valid.
This **fails fast** with a clear error message instead of spawning multiple failing
concurrent processes.

**Why this matters:**

Without a health check, syncing 100 files with invalid credentials would spawn up to
`sync.parallel` (default 8) concurrent failed transfers, producing 8 identical error
messages simultaneously.
This is confusing and wasteful.

With a health check, blobsy detects the auth problem immediately and shows one clear
error before attempting any transfers.

**Health check per backend:**

| Backend | Health Check Operation | What It Validates |
| --- | --- | --- |
| `s3` | `HeadBucket` or small `ListObjectsV2` (1 item) | Credentials valid, bucket exists, region correct, network reachable |
| `local` | `stat()` on the target directory | Directory exists and is writable |
| `command` | Run push_command with a tiny test file (writes + deletes 1 KB test object) | Command syntax valid, remote accessible, credentials work |

**Health check is:**
- **Fast** - single lightweight operation (< 1 second in normal cases)
- **Skippable** - `--skip-health-check` flag for advanced users who know backend is
  healthy
- **Cached** - health check result cached for 60 seconds to avoid redundant checks
  across multiple sync commands

**Failure modes:**

```bash
$ blobsy push
Checking backend health...
✗ Backend health check failed

Error: Cannot access s3://my-bucket/
Command: aws s3api head-bucket --bucket my-bucket
Exit code: 254

Output:
An error occurred (NoSuchBucket) when calling the HeadBucket operation: The specified
bucket does not exist

Troubleshooting:
- Verify bucket name: my-bucket
- Check region in .blobsy.yml: us-east-1
- Run: aws s3 ls s3://my-bucket/ --region us-east-1
- See: https://github.com/jlevy/blobsy/docs/troubleshooting#bucket-config

Aborting sync. Fix backend configuration and try again.
```

**Success (normal case):**

```bash
$ blobsy push
✓ Backend healthy (s3://my-bucket/)
Pushing 42 files...
  ✓ data/file1.bin (1.2 GB) - ok
  ✓ data/file2.bin (500 MB) - ok
  ...
```

**Exposed as `blobsy health` command:**

Health checks are also exposed as a standalone command for troubleshooting:

```bash
$ blobsy health
Checking transport backend health...

Backend: s3
  Bucket: my-bucket
  Region: us-east-1
  Prefix: project-v1/

✓ Credentials valid (AWS profile: default)
✓ Bucket accessible
✓ Can write (test upload: 1 KB)
✓ Can read (test download: 1 KB)
✓ Can delete (cleaned up test object)

Transfer tools:
  ✓ aws-cli v2.13.5 (using this)
  ✗ rclone (not installed)

All checks passed. Backend is healthy.
```

With `--json`:

```json
{
  "schema_version": "0.1",
  "backend": {
    "type": "s3",
    "bucket": "my-bucket",
    "region": "us-east-1",
    "prefix": "project-v1/"
  },
  "health_checks": {
    "credentials": {"status": "ok", "message": "AWS profile: default"},
    "bucket_access": {"status": "ok", "message": "Bucket accessible"},
    "can_write": {"status": "ok", "message": "Test upload: 1 KB"},
    "can_read": {"status": "ok", "message": "Test download: 1 KB"},
    "can_delete": {"status": "ok", "message": "Cleaned up test object"}
  },
  "transfer_tools": {
    "selected": "aws-cli",
    "aws-cli": {"available": true, "version": "2.13.5"},
    "rclone": {"available": false, "error": "not found in PATH"}
  },
  "overall_status": "healthy"
}
```

**Integration with `blobsy doctor`:**

`blobsy doctor` includes health check results in its comprehensive diagnostics (see
`blobsy doctor` command documentation).

**V1 implementation note:**

Health checks are implemented in V1 for S3 and local backends.
Command backends skip health checks in V1 (deferred to V2) since arbitrary commands may
not have a safe, side-effect-free health check operation.

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
| (none) | h | yes | **Needs pull** | missing | pulls blob |
| (none) | h | no | **Data loss** | missing (no remote!) | errors |
| h' | h | yes | **Modified locally** | modified | warns |
| h' | h | no | **Modified + not pushed** | modified (not pushed) | warns |
| h | (none) | -- | **Untracked** | (not shown) | (ignored) |
| (none) | (none) | old | **Orphaned remote** | (not shown) | `gc` candidate (V2) |

## Conflict Model

### Why Conflicts Are Trivially Resolved

Each file has its own `.yref`. Two people modifying different files change different
`.yref` files. Git auto-merges with zero conflicts.

The only conflict case: two people modify **the same file**. Then git sees a conflict on
that file’s `.yref`:

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
$ git checkout --theirs data/results.json.yref
$ git add data/results.json.yref
$ blobsy pull data/results.json    # get their version of the actual file
```

No custom resolution tooling needed.
Every developer already knows how to resolve git conflicts.

### Conflict Detection

Git handles `.yref` merge conflicts.
But there is a second class of conflict that git cannot see: **payload-vs-ref
desynchronization**. Since payload files are gitignored, git pull can update a `.yref`
file while leaving the local payload stale.
Without detection, `blobsy sync` cannot distinguish “user modified the file” from “git
pull updated the ref” and may incorrectly push stale content, reverting someone else’s
changes.

Blobsy uses a three-layer defense:

1. **Prevention (Primary):** A pre-commit hook (installed by `blobsy init`) auto-runs
   `blobsy push` when committing `.yref` files.
   This ensures blobs are uploaded before refs enter git history.
   `blobsy push` also verifies the local file hash matches the `.yref` hash, catching
   files modified after tracking.

2. **Detection (Secondary):** The stat cache provides the merge base for three-way
   conflict detection during sync.
   For each file, blobsy compares the local hash, the `.yref` hash, and the cached hash
   (last known state) to determine the correct action.
   See [stat-cache-design.md](stat-cache-design.md) for the full decision table and
   algorithm.

3. **Attribution (Tertiary):** When a blob is missing from remote storage, error
   messages use git blame to identify who committed the `.yref` without pushing, with
   actionable resolution steps.

See [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) for
full design: race condition analysis, pre-commit hook implementation, push sanity
checks, attribution error messages, and FAQ.

### Single-Writer Model (V1)

Blobsy assumes one writer per tracked file at a time.
This is the common case: each developer works on their own files.
Content-addressable storage means concurrent pushes of different files never interfere
-- different content hashes produce different remote keys.

If two users push the same content for the same file, they write the same key
(idempotent PUT). If they push different content, both blobs exist in the remote; the
git merge of `.yref` files determines which one wins.

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

The `.yref` files live adjacent to their data files.
Since only the data files are gitignored (not the directory), git sees the `.yref` files
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
  trash/                          # expired .yref files from blobsy untrack
    data/bigfile.zip.yref         # preserves path structure
    data/research/old-model.bin.yref
```

### Purpose

When you `blobsy untrack` a file, the `.yref` is moved here instead of deleted.
This serves two purposes:

1. **GC paper trail (V2).** `blobsy gc` (V2 feature) can scan `.blobsy/trash/` to find
   remote blobs that were once tracked but are no longer referenced by any live `.yref`.
   Without the trash, GC would have to walk the entire git history to discover orphaned
   blobs.

2. **Undo safety net.** If you untrack something by mistake, the `.yref` is still in
   `.blobsy/trash/` (and in git history).
   You can recover it.

### GC Cleans the Trash (V2)

`blobsy gc` (V2 feature) removes trash entries whose remote blobs have been cleaned up.
Trash entries whose blobs are still referenced by other live `.yref` files on other
branches are kept until those references are also gone.

### What `.blobsy/` Contains

- **Trash** for soft-deleted refs (see above).
- **Stat cache** at `.blobsy/stat-cache/` (gitignored, machine-local).
  One JSON file per tracked file.
  See [stat-cache-design.md](stat-cache-design.md).

### What `.blobsy/` Does Not Contain

- **No config.** Config lives in `.blobsy.yml` files (hierarchical, placed anywhere).
- **No manifests.** There are no manifests.

## Security and Trust Model

### Threat: Command Execution from Repo Config

Repo-level `.blobsy.yml` can specify `command` backends with arbitrary shell commands.
Running `blobsy pull` on a cloned repo could execute arbitrary commands from the repo’s
config. This is a supply-chain risk.

### Policy

**`command` backends and any custom command execution are disallowed from repo-level
config by default.** They are only permitted from:

- User-level config (`~/.blobsy.yml`), or
- Repos that have been explicitly trusted via `blobsy trust`.

When a repo’s `.blobsy.yml` contains a `command` backend, blobsy refuses with a clear
error:

```
Error: .blobsy.yml specifies a 'command' backend, which can execute
arbitrary shell commands. This is not allowed from repo config by default.

To trust this repo's config:
  blobsy trust

Or configure the backend in your user config:
  ~/.blobsy.yml
```

`blobsy trust` creates a trust marker (stored in user-local config, not committed to
git) that allows command execution for this specific repo.

### Backend Authentication

Blobsy itself handles no credentials.
Authentication is delegated to the backend’s standard credential chain (AWS IAM, env
vars, shared credentials files).
No secrets are ever stored in `.blobsy.yml` or `.yref` files.

## Workflows and Scenarios

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

**No post-merge gap.** The blobs were pushed from the feature branch.
After merge, the `.yref` files on main point to the same blobs (same content hash = same
remote key). `blobsy sync` on main has nothing to do -- the blobs are already there.

This completely eliminates the post-merge promotion problem from the original design.

### Directory with Mixed Files

A directory containing both large files (externalized via blobsy) and small files
(committed to git directly).
The externalization rules in `.blobsy.yml` handle this automatically.

```bash
$ blobsy track data/analysis/
Scanning data/analysis/...
  data/analysis/model-weights.bin    (120 MB, .bin)   -> externalized (.yref)
  data/analysis/embeddings.parquet   (45 MB, .parquet) -> externalized (.yref)
  data/analysis/process.py           (3 KB, .py)       -> kept in git
  data/analysis/config.yaml          (1 KB, .yaml)     -> kept in git
  data/analysis/README.md            (2 KB, .md)       -> kept in git
2 files tracked, 3 kept in git.

$ git add data/analysis/*.yref .gitignore
$ git commit -m "Track analysis data with blobsy"
```

Small files stay in git.
Large files get `.yref` files and gitignore entries.
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
or detached HEAD pulls the same blobs referenced by the committed `.yref` files.

## Corner Cases and Pitfalls

### Push/Commit Coordination

**Pushed data but forgot to commit the ref.** User runs `blobsy push` (data uploads to
remote) but doesn’t `git add` and `git commit` the updated `.yref` file.
Other users have no way to know the remote data changed.
The ref in git still references the old hash.

Recovery: commit the ref file.
Until then, other users see no change.

Detection: `blobsy status` on the pusher’s machine shows “up-to-date” (local matches
ref). The problem is invisible to the pusher -- it only manifests when other users don’t
see the update. This is the most common mistake.

**Committed the ref but forgot to push data.** User updates a file, commits the `.yref`,
but doesn’t run `blobsy push`. Other users pull from git, see the updated ref, run
`blobsy pull`, and the remote blob doesn’t exist.

Recovery: the original user runs `blobsy push` to upload the data that matches the
committed ref.

Prevention: the pre-commit hook (installed by `blobsy init`) auto-pushes blobs when
committing `.yref` files, preventing this scenario.
See [Conflict Detection](#conflict-detection).

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
The `.yref` hash no longer matches the file.
The pre-commit hook’s sanity check catches this: `blobsy push` fails with a hash
mismatch error, blocking the commit.
Resolution: re-run `blobsy track` to update the `.yref`.

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
In V1, use `blobsy rm` to manually remove blobs you no longer need.
In V2, `blobsy gc` will provide automatic cleanup with age-based retention.

**Manually edited `.yref` file.** If a user or tool modifies the hash, size, or other
fields in a ref file, `blobsy status` may show incorrect state.
`blobsy verify` detects mismatches between the ref hash and the actual local file.
`blobsy track` recalculates the hash and overwrites the ref with correct values.

### Gitignore Misconfiguration

**Accidentally committed large files to git.** If `.gitignore` doesn’t cover a
blobsy-tracked file, `git add .` stages it.
Large files end up in git history permanently.

Prevention: `blobsy track` always adds the file to `.gitignore` before creating the
`.yref`. Verify `.gitignore` after setup.
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

**10,000 files = 10,000 `.yref` files.** Git handles millions of files routinely.
In file browsers, the `.yref` files are interspersed with the actual files -- but the
actual files are gitignored, so `git ls-files` only shows `.yref`s.

For extreme cases, a future option could store `.yref` files in a parallel directory
(e.g., `data/research.yrefs/`) for cleanliness.
This is deferred to V2+.

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

Every `.yref` file starts with:

```
# blobsy -- https://github.com/jlevy/blobsy
```

An agent encountering a `.yref` file for the first time can read this header, visit the
URL or run `npx blobsy --help`, and understand the system without external
documentation.

### Non-Interactive by Default

All sync operations (`push`, `pull`, `sync`, `status`, `verify`) are fully
non-interactive. They succeed or fail without prompts.
`--force` for destructive operations.
`--dry-run` for preview.
This makes `blobsy` safe to call from scripts, CI pipelines, and agent tool loops.

`blobsy init` is interactive when run without flags (prompts for backend type, bucket,
region). For non-interactive usage, pass flags directly:
`blobsy init --bucket my-data --region us-east-1`. All other commands are always
non-interactive.

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

**Minimum Node.js version:** Node.js 22.11.0 or later (required for `node:zlib` zstd
support). Older versions can still use gzip or brotli compression.

### No Daemon

See [Design Decisions](#design-decisions).
Pure CLI with no background processes.
If the stat cache is missing, blobsy auto-rebuilds it where unambiguous and errors with
resolution guidance where ambiguous.

### Testing

See [Design Decisions](#design-decisions) for the local backend testing approach and
golden test philosophy.

#### Golden Tests for User-Facing Output

Blobsy uses golden/snapshot tests for all user-facing output (status, sync summaries,
doctor diagnostics, `--json` shapes, and error messages).
Error messages in particular are critical UX and must be tested for every scenario.

**Required error test cases:**

1. **Authentication failures:**
   - Missing credentials (AWS_ACCESS_KEY_ID unset)
   - Invalid credentials (wrong access key)
   - Expired credentials (temporary credentials past expiry)

2. **Permission errors:**
   - IAM policy missing s3:PutObject
   - IAM policy missing s3:GetObject
   - Bucket policy denying access

3. **Resource not found:**
   - Bucket doesn’t exist
   - Wrong region configured
   - Blob missing on pull (committed ref but data not pushed)

4. **Network errors:**
   - Connection timeout (simulated with unreachable endpoint)
   - DNS resolution failure
   - Connection refused

5. **Storage errors:**
   - Disk full on pull (local filesystem)
   - Bucket quota exceeded (S3 quota)

6. **Command failures:**
   - Transfer tool not installed (aws-cli missing from PATH)
   - Transfer tool returns unexpected output
   - Malformed command template (missing {local} variable)

7. **Health check failures:**
   - Health check detects auth failure before starting sync
   - Health check detects bucket doesn’t exist before starting sync
   - Health check detects network timeout before starting sync
   - `blobsy health` command shows detailed diagnostics
   - `--skip-health-check` flag bypasses health check when needed

**Golden test implementation pattern:**

```typescript
// tests/golden/transport-errors.test.ts
describe('transport error messages', () => {
  it('shows helpful message for missing AWS credentials', async () => {
    // Setup: unset AWS credentials, track a file
    const result = await runBlobsy(['push', 'data/model.bin'], {
      env: { ...process.env, AWS_ACCESS_KEY_ID: undefined }
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatchSnapshot()
    // Snapshot includes:
    // - "Unable to locate credentials"
    // - "aws configure" suggestion
    // - Link to AWS docs
  })

  it('shows helpful message for wrong bucket/region', async () => {
    // Setup: configure backend with non-existent bucket
    const result = await runBlobsy(['pull', 'data/model.bin'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatchSnapshot()
    // Snapshot includes:
    // - "NoSuchBucket" error
    // - Bucket name and region from config
    // - Suggestion to verify with aws s3 ls
  })

  // ... tests for all error scenarios listed above
})
```

**Snapshot maintenance:**
- Error message snapshots are committed to the repo
- CI fails if error messages change unexpectedly
- Intentional error message improvements require explicit snapshot updates
- Ensures error UX remains consistent and helpful across releases

**Error message quality checklist:**

Every error message must:
- ✓ Show the failed file path and size
- ✓ Show the exact command that failed (with variables expanded)
- ✓ Show the full error output (both stdout and stderr)
- ✓ Categorize the error (authentication, network, permission, etc.)
- ✓ Suggest concrete next steps for resolution
- ✓ Link to relevant documentation
- ✓ Work correctly in both human-readable and `--json` output modes

## V1 Scope

**Note:** This document describes the V2 design architecture.
“V1 Scope” refers to the initial shipping scope implementing this V2 architecture (not
the older V1 manifest-based design).

### What blobsy does (V1)

- Track files via per-file `.yref` ref files committed to git
- Content-addressable remote storage with automatic dedup
- Push/pull/sync with pluggable backends and configurable transfer tools
- Per-file compression via Node.js built-in zstd/gzip/brotli
- SHA-256 integrity verification
- Content-addressable garbage collection (V2 feature)
- Hierarchical `.blobsy.yml` configuration with externalization and compression rules
- Per-file gitignore management
- Machine-readable `--json` output for agents
- `blobsy doctor` for basic diagnostics (V2: enhanced with error detection and auto-fix)
- `blobsy status` for per-file state (V2: enhanced with file sizes)
- Full file versioning via git history of `.yref` files

### What blobsy does not do (V1)

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
- Parallel `.yref` directory option (`.yref` files always adjacent to data files)
- Batched multi-file transfer / transfer engine abstraction (V1 uses per-file
  concurrency with a pool; V2 adds pluggable `TransferEngine` with batch support)

These are candidates for future versions if demand warrants.

### What’s Deferred (V2+)

- **Transfer engine abstraction.** V1 uses per-file CLI spawning with a concurrency
  pool. V2 introduces a pluggable `TransferEngine` interface that supports both per-file
  and batched transfer modes:

  ```typescript
  interface TransferEngine {
    // Per-file transfer (V1 model, always supported)
    transferFile(src: string, dest: string): Promise<void>

    // Batch transfer (V2 optimization, optional)
    transferBatch?(files: Array<{src: string, dest: string}>): Promise<void>
  }
  ```

  When `transferBatch` is available, blobsy passes all files in a single call, letting
  the engine manage its own concurrency (connection pooling, worker threads, etc.). This
  eliminates per-file process spawn overhead and enables tools like `s5cmd` (batch mode
  via `run` command) and `rclone` (`--files-from` flag) to operate at peak throughput.

- **Additional transfer tool presets.** V1 supports `aws-cli` and `rclone`. V2 adds
  first-class presets for:
  - `s5cmd` -- Go-based, fastest for many-file workloads via batch mode.
  - `gcloud` -- native GCS transfers with ADC auth (no HMAC keys).
  - `azcopy` -- native Azure Blob transfers.

  Each preset implements `TransferEngine` with tool-specific optimizations (e.g., s5cmd
  batch file, rclone `--files-from`, gcloud parallel composite uploads).

- **Parallel `.yref` directory option.** Storing `.yref` files in a parallel directory
  (e.g., `data/research.yrefs/`) instead of adjacent to data files.

- **Garbage collection (`blobsy gc`).** Removes remote blobs not referenced by any
  `.yref` file in any reachable git branch or tag.
  With `blobsy rm` available in V1 for manual cleanup, automatic GC is less critical and
  is deferred to V2.

  **Safety requirements (V2 design):**

  - **MUST require explicit safety parameter:** Either `--depth=N` (only scan last N
    commits on each branch) or `--age="duration"` (only remove blobs older than
    specified duration like “7 days” or “30d”).
  - **MUST support `--dry-run` mode** showing what would be removed before actual
    deletion.
  - **Algorithm:**
    1. Collect all `remote_key` values from `.yref` files across all reachable
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
  values in `.yref` files, correctly handling content-addressable, branch-isolated,
  shared, and mixed layouts.

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
    Fully offline (reads from `.yref` metadata).
    Use `blobsy stats` for quick repo health check; `blobsy status` for per-file detail.
  - **`blobsy status` enhancement:** Add human-readable file sizes (KB, MB, GB) to
    per-file output for consistency with `blobsy stats`.

- **Enhanced `blobsy doctor` diagnostics.** Expand `blobsy doctor` to be a comprehensive
  health check and troubleshooting tool:
  - **Aggregate stats rollup** (superset of `blobsy stats`)
  - **Common error detection:**
    - Missing `.gitignore` entries for tracked files
    - Orphaned `.gitignore` entries (file no longer tracked)
    - Invalid `.yref` files (malformed YAML, unsupported format versions)
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
- **`blobsy resolve`** -- standard git conflict resolution works for `.yref` merges.
  Payload-vs-ref desync is detected automatically (see
  [Conflict Detection](#conflict-detection)); no explicit resolve command needed.
- **`blobsy ns ls` / `blobsy ns show` / `blobsy ns copy` / `blobsy promote`** -- no
  namespaces to manage.
- **Post-merge promotion** -- blobs are where they are, refs point to them.
- **Delete semantics debate** -- old blobs exist until GC; new pushes never overwrite
  (content-addressed).
- **Bidirectional sync complexity** -- `sync` = push missing + pull missing; no delete
  cascades.

## Review Issues Resolution

This section maps all issues raised across the design reviews to their resolution in
this consolidated design.

**Review sources:**

- [Round 1: General review](blobsy-design-review-round1-general.md) (C1-C4, S1-S7,
  M1-M11)
- [Round 2: Checksum deep-dive](blobsy-design-review-round2-checksums.md)
- [Round 3: GPT5Pro architecture review](blobsy-design-review-round3-gpt5pro.md)
- [Round 4: GPT5Pro incorporation guide](blobsy-design-review-round4-gpt5pro.md)

### Resolved by Per-File `.yref` Architecture

These issues are eliminated by the architectural shift to per-file refs and
content-addressable storage.

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-cx82` | R3 P0-1 | Versioning semantics: “latest mirror” vs “immutable snapshots” | **Resolved.** Content-addressable storage = immutable blobs. Git history of `.yref` files = full versioning. Old commits can be checked out and pulled (blobs are never overwritten). No contradiction. |
| `blobsy-mlv9` | R3 P0-3 | `manifest_sha256` for directory pointers | **Eliminated.** No manifests, no directory pointers. Each file has its own `.yref` with its own `hash`. Git diff is meaningful per-file. |
| `blobsy-a64l` | R3 P0-2 | Post-merge promotion workflow | **Eliminated.** Content-addressable blobs are not prefix-bound. After merge, `.yref` files on main point to the same blobs that were pushed from the feature branch. No promotion needed. |
| `blobsy-05j8` | R3 P0-4.2 | Delete semantics contradiction | **Eliminated.** Content-addressable storage never deletes or overwrites during sync. Old blobs remain until GC. No delete flags needed for push/pull. |
| `blobsy-7h13` | R1 C2, R3 P0-4 | Single-file remote conflict detection | **Eliminated.** No “remote hash Z” needed. `.yref` merge conflicts handled by git. Payload-vs-ref desync detected by stat cache three-way merge (see [Conflict Detection](#conflict-detection)). Content-addressable = concurrent pushes of different content produce different keys (no overwrite). |
| `blobsy-lsu9` | R3 P0-5 | Compression + transfer mechanics | **Resolved.** File-by-file orchestration (compress -> copy -> cleanup). Transfer tools used as copy engines, not diff engines. No staging directory needed. Compression is V1 via Node.js built-in `node:zlib`. |

### Resolved in Spec (Carried Forward)

These issues were resolved in the original spec and remain resolved in this design.

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-suqh` | R1 C3, R3 4.9 | Interactive init contradiction | **Resolved.** `init` is interactive without flags; all sync ops are non-interactive. See Non-Interactive by Default. |
| `blobsy-br1a` | R1 C4, R3 5 | `blobsy sync` bidirectional danger | **Simplified.** Sync = push missing + pull missing. No delete cascades. No `--strategy` flag in V1. |
| `blobsy-jlcn` | R1 M1, R3 4.1 | Pointer field types | **Resolved.** hash = content identifier (sha256:64-char-hex), size = bytes. See Ref File Format. |
| `blobsy-n23z` | R1 M2 | Format versioning | **Resolved.** `<name>/<major>.<minor>`, reject on major mismatch, warn on newer minor. |
| `blobsy-0a9e` | R1 M3, R3 4.10 | Command backend template variables | **Resolved.** `{local}`, `{remote}`, `{relative_path}`, `{bucket}` specified. See Backend System. |
| `blobsy-srme` | R1 M4, R3 4.8 | Which `.gitignore` to modify | **Resolved.** Same directory as tracked path. See Gitignore Management. |
| `blobsy-v9py` | R1 M5, R3 4.3 | Detached HEAD SHA length | **Mostly eliminated.** No namespace prefixes in content-addressable mode. Detached HEAD is not special -- `.yref` files reference content hashes, not branch prefixes. |
| `blobsy-bnku` | R1 M7, R3 4.4 | Push idempotency | **Resolved.** Content-addressable = inherently idempotent. Same hash = same key = no-op PUT. |
| `blobsy-q6xr` | R3 4.4 | Pull behavior on local mods | **Resolved.** Default: error on modified files unless `--force`. See Pull section. |
| `blobsy-txou` | R3 4.2 | Manifest canonicalization | **Eliminated.** No manifests. `.yref` files use stable key ordering. |
| `blobsy-v6eb` | R3 4.1 | Stable pointer key ordering | **Resolved.** Keys written in documented fixed order. See Ref File Format. |
| `blobsy-mg0y` | R3 4.9 | `--json` schema version | **Resolved.** `schema_version` field in all JSON output. |
| `blobsy-pice` | R3 4 | SDK endpoint wording | **Resolved.** Correct wording: SDK uses config object, not CLI flags. |
| `blobsy-r34j` | R1 S2 | gc safety (remote branches) | **Simplified.** Content-addressable GC scans all branches/tags for referenced hashes. No branch-prefix-based GC. |

### Still Relevant (Addressed in This Doc)

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-rel2` | R3 4.5 | Atomic writes for built-in transport | **Addressed.** Temp-file-then-rename for ALL backends (built-in SDK, external tools, command backends). Blobsy manages atomicity; does not rely on transport. See Atomic Writes section. |
| `blobsy-vj6p` | R3 4.10 | Security: command execution from repo config | **Addressed.** `command` backends disallowed from repo config by default. See Security and Trust Model. |
| `blobsy-y72s` | R1 S7, R3 4.6 | Auto tool detection robustness | **Addressed.** Ordered `sync.tools` list with capability check + fallthrough + `blobsy doctor`. See Transfer Delegation. |

### Eliminated by Architecture Change

| Bead | Review IDs | Issue | Status |
| --- | --- | --- | --- |
| `blobsy-u4cs` | R1 S1, R3 4.3 | Branch name sanitization | **Eliminated.** No namespace prefixes in content-addressable mode. Branch names never appear in remote keys. |
| `blobsy-q2dd` | R1 S4, R3 4.3 | Version namespace mode | **Eliminated.** No namespace modes. Versioning = git history. |
| `blobsy-p8c4` | R3 4.2 | `stored_as` in manifest | **Eliminated.** No manifests. Compression state stored in `.yref`. |
| `blobsy-fjqj` | R3 4.7 | Compression skip list in repo config | **Addressed.** Compression rules in `.blobsy.yml`. See Compression Rules. |

### Deferred (P2 / V2)

| Review IDs | Issue | Status |
| --- | --- | --- |
| R1 M8 | Dictionary compression | Deferred to V2. |
| R1 M6 | Export/import specification | Deferred to V2. |
| R1 M9 | Team adoption workflow docs | Deferred. |
| R1 M10, R3 7 | Integration surface (library vs CLI) | Stated: standalone CLI + npm package. |
| R3 4.8 | Mixed directories: ignore vs include patterns | Resolved by externalization rules. |
| R1 M11 | `command` backend as integration point | Noted in Backend Types description. |
| R3 5 | s5cmd as future transport engine | Deferred to V2. V1 ships with aws-cli + rclone + template commands. |
| R1 S6, R3 4.7 | Compression suffix convention | Accepted: `.zst` suffix in remote; compression state in `.yref`. |
| R3 4.7 | Small-file compression threshold | Built in: `compress.min_size: 100kb` default. |
