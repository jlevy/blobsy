# blobsy: Large Object Storage for Git Repos (V2 Consolidated Design)

**Status:** Draft

**Date:** 2026-02-20

**Supersedes:** [blobsy-design.md](blobsy-design.md) (original comprehensive design) and
[blobsy-git-manifest-alt-design.md](blobsy-git-manifest-alt-design.md) (per-file ref
architecture). Those documents remain in place for reference.

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
| Conflict resolution | Git (standard merge on `.yref` files) | Nothing -- git handles it |
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
| `{content_sha256}` | Full SHA-256 hash (64 chars) | `7a3f0e9b2c1d4e5f...` |
| `{content_sha256_short}` | Short hash (12 chars) | `7a3f0e9b2c1d` |
| `{repo_path}` | Repository-relative path | `data/research/model.bin` |
| `{filename}` | Filename only | `model.bin` |
| `{dirname}` | Directory path only | `data/research/` |
| `{git_branch}` | Current git branch | `main`, `feature/x` |

Any text outside `{...}` is kept as-is (literal prefix/suffix).

#### Common Layout Patterns

Blobsy supports three common patterns out of the box.
Each optimizes for different needs.

##### Pattern 1: Content-Addressable (Default - Recommended)

**Maximum deduplication across all branches and paths.**

```yaml
# .blobsy.yml
backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: project-alpha/
    region: us-east-1

remote:
  key_template: "sha256/{content_sha256}"  # default
```

**Example remote keys:**
```
s3://my-datasets/project-alpha/
  sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
  sha256/b4c8d2a1e3f5b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6
  sha256/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

**Properties:**
- ✅ **Maximum dedup:** Same content anywhere (any path, any branch) = single copy
- ✅ **Immutable:** Hash = identity, blobs never overwritten
- ✅ **Fast renames/moves:** No re-upload needed (hash doesn’t change)
- ✅ **Simple GC:** Delete blobs whose hash not referenced by any `.yref`
- ✅ **No post-merge gap:** Feature branch blob = same key as main
- ⚠️ **Not path-browsable:** Remote shows hashes, not paths

**Browsability options:**
- Store filename in S3 object metadata (`x-amz-meta-original-filename`)
- Add cosmetic filename suffix: `sha256/{content_sha256}---{filename}`
- Use `.yref` files in git to map hashes to paths

**Use when:** You want minimal storage usage and maximum deduplication.
Best for production use, cost-sensitive teams, and ML model/dataset versioning.

##### Pattern 2: Branch-Isolated Storage

**Separate namespaces per branch, with dedup within each branch.**

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

##### Pattern 3: Global Shared Backing Store

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

|  | Content-Addressable | Branch-Isolated | Global Shared |
| --- | --- | --- | --- |
| **Template** | `sha256/{content_sha256}` | `{git_branch}/sha256/{content_sha256}` | `shared/{repo_path}` |
| **Dedup** | Maximum (global) | Per-branch | None |
| **Browsability** | By hash only | By branch, then hash | By path |
| **Rename cost** | Free (no re-upload) | Free (no re-upload) | Re-upload required |
| **Branch merges** | Blobs already shared | Blobs in feature namespace | N/A |
| **Storage growth** | Minimal | Moderate | High (no dedup) |
| **GC complexity** | Simple (hash-based) | Moderate (branch-aware) | Simple (path-based) |
| **Best for** | Production, cost-sensitive | Multi-branch workflows | Simple sync, external tools |

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

1. **On `blobsy track`:** Compute hash, create `.yref` with `sha256` and `size` (no
   remote key yet)
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
sha256: 7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_prefix: sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
```

Fields:

| Field | Type | Description |
| --- | --- | --- |
| `format` | string | Format version (`blobsy-yref/0.1`) |
| `sha256` | string | 64-char lowercase hex, SHA-256 of the original file content |
| `size` | integer | File size in bytes |
| `remote_prefix` | string | Remote prefix where the blob was pushed (set by `blobsy push`). Empty or absent until first push. |

**Field types and encoding:**

- `sha256`: 64-character lowercase hexadecimal string.
- `size`: integer, in bytes.

**Format versioning:** The `format` field uses `<name>/<major>.<minor>` versioning
(e.g., `blobsy-yref/0.1`). Compatibility policy: reject if major version is unsupported;
warn if minor version is newer than the running blobsy version supports.

**Why `remote_prefix` is in the ref:** Pull needs to know where to find the blob.
Storing it in the ref means git versions it, and anyone who checks out the ref can pull
without additional state.
Push sets this field; it’s empty (or absent) until the first push.

**Why no `updated` timestamp:** Git already tracks when the file changed (`git log`). A
timestamp in the ref adds no information and creates meaningless diffs.

### Ref with Compression

When a file is compressed before upload, the `.yref` records this:

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
sha256: 7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_prefix: sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
compressed: zstd
compressed_size: 4194304
```

The hash is always of the original file -- this ensures `blobsy status` can verify
integrity by hashing the local file without decompressing anything.

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
`.yref`’s `sha256`, report mismatches.
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
last-known `size`, `mtime_ms`, and `sha256` for each tracked file.
This follows the same approach as git’s index: use filesystem metadata as a fast-path to
avoid re-hashing unchanged files.

**How it works:**

1. On push, sync, or verify, blobsy calls `stat()` on each local file.
2. If `size` and `mtime_ms` match the cached entry, the cached `sha256` is trusted (file
   assumed unchanged -- no read or hash needed).
3. If either differs, blobsy reads and hashes the file, then updates the cache.

**Why mtime is safe in the local cache but not in refs:** The stat cache is local and
per-machine. It only compares a file’s current mtime against the mtime recorded *on the
same machine* after the last hash.
This is a “definitely changed” signal -- if mtime changed, something touched the file.
The `.yref` file cannot use mtime because different machines, git checkouts, CI runners,
and Docker builds all produce different mtimes for the same content.

**High-resolution timestamps:** Node.js `fs.stat()` provides `mtimeMs` (millisecond
float) on all platforms.
Millisecond resolution is sufficient -- sub-millisecond file modifications between cache
writes are unlikely in practice.

**Performance impact:** `stat()` costs ~1-5 microseconds per file.
For a directory with 1,000 files, the stat pass takes ~~5 ms.
Without the cache, every push would read and hash all 1,000 files (~~seconds to minutes
depending on sizes).

| Scenario (1000 files, 10 MB avg) | Without stat cache | With stat cache |
| --- | --- | --- |
| First push | Hash all: ~20s | Hash all: ~20s (same) |
| Second push, 3 files changed | Hash all: ~20s | Stat all + hash 3: ~65ms |
| After `git checkout` (mtime reset on all) | Hash all: ~20s | Stat all + hash all: ~20s |

**Cache invalidation:** The cache is a pure optimization.
If missing or corrupted, blobsy falls back to hashing all files (correct but slower).
The cache is never shared across machines -- it is gitignored and machine-local.

### Future: Remote Staleness Detection via Provider Hashes

One optimization for a future version: after a successful push, blobsy could store the
provider’s response hash (e.g., ETag, `x-amz-checksum-crc64nvme`) alongside the
`remote_prefix` in the `.yref`. This enables cheap remote staleness detection: a
`HeadObject` request returns the current provider hash, and if it matches the stored
value, the remote file hasn’t changed since last push -- without downloading or
re-hashing.

This is not needed for V1 -- SHA-256 hashes in `.yref` files handle all verification
needs.

## CLI Commands

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
Updated data/research/model.bin.yref (sha256 changed)

# Or refresh all tracked files in a directory
$ blobsy track data/research/
Updated data/research/model.bin.yref (sha256 changed)
1 file updated, 1 unchanged.
```

### `blobsy untrack`

Stop tracking a file or directory.

```bash
$ blobsy untrack data/bigfile.zip
Untracked data/bigfile.zip
Moved data/bigfile.zip.yref -> .blobsy/trash/data/bigfile.zip.yref
Removed data/bigfile.zip from .gitignore
(Local file preserved)

# Directory (recursive)
$ blobsy untrack data/research/
Untracked 2 files in data/research/
Moved data/research/model.bin.yref -> .blobsy/trash/data/research/model.bin.yref
Moved data/research/raw/data.parquet.yref -> .blobsy/trash/data/research/raw/data.parquet.yref
Removed 2 entries from .gitignore
(Local files preserved)
```

What it does:

1. Move each `.yref` to `.blobsy/trash/` (preserving the path structure).
2. Remove the gitignore entry.
3. Leave local files and remote blobs untouched.

The user then `git add` + `git commit` to finalize.
The trash gives `blobsy gc` a record of which remote blobs were once referenced.

### `blobsy sync`

The primary sync command.
Ensures local files and remote blobs match the committed refs.

```bash
$ blobsy sync
Syncing 4 tracked files...
  data/bigfile.zip                  ok (up to date)
  data/research/report.md           pushed (4 KB)
  data/research/raw/response.json   pulled (1.0 MB)
  data/research/raw/data.parquet    ok (up to date)
Done. 1 pushed, 1 pulled, 2 up to date.
```

**Precondition: `.yref` files must be committed to git.** If any `.yref` has uncommitted
changes, sync errors:

```
Error: data/bigfile.zip.yref has uncommitted changes.
Run 'git add' and 'git commit' first.
```

Algorithm for each `.yref`:

1. **Read the ref** -- get `sha256`, `size`, `remote_prefix`.
2. **Check local file** -- hash it (using stat cache for speed).
3. **If local matches ref and remote has the blob:** nothing to do.
4. **If local matches ref but remote doesn’t have it:** push (upload blob, set
   `remote_prefix` in ref).
5. **If local is missing but remote has the blob:** pull (download blob).
6. **If local differs from ref:** warn -- file was modified locally but ref not updated.
   Run `blobsy track` to update the ref first.
   Sync does not overwrite local modifications.

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
  data/bigfile.zip              ok
  data/research/report.md       modified (local != ref)
  data/research/raw/resp.json   missing locally
  data/research/raw/data.parq   ok (not pushed)
```

What it does:

1. Find all `.yref` files in the repo.
2. For each, compare local file hash against the ref’s `sha256`.
3. Report: ok, modified, missing, not pushed (no `remote_prefix`).

No network access. The ref file has everything needed.

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

### `blobsy gc`

With content-addressable layout (default), GC removes blobs not referenced by any
`.yref` file on any reachable branch:

```bash
$ blobsy gc --dry-run
Scanning refs across all branches...
Scanning remote blobs...
  sha256/7a3f0e... referenced by main, feature/x   -> KEEP
  sha256/b4c8d2... referenced by main               -> KEEP
  sha256/old123... not referenced                    -> REMOVE (50 MB)
Would remove: 1 blob, 50 MB

$ blobsy gc
Removed: sha256/old123.../data/old-file.bin (50 MB)
Done. 1 blob removed, 50 MB freed.
```

Algorithm:

1. Collect all `sha256` values from all `.yref` files across all reachable
   branches/tags.
2. Scan `.blobsy/trash/` for expired refs.
3. List all remote objects.
4. Remove objects whose hash isn’t in the referenced set.

**Safety:**

```bash
blobsy gc --dry-run              # preview only
blobsy gc --older-than 30d       # only remove blobs older than 30 days
```

GC also cleans `.blobsy/trash/` entries whose remote blobs have been removed.
Trash entries whose blobs are still referenced by live `.yref` files on other branches
are kept until those references are also gone.

With timestamp-hash layout, GC removes entire prefixes whose git commit is unreachable.

### `blobsy doctor`

Diagnostic command that prints resolved configuration and detected issues:

```bash
$ blobsy doctor
Backend: s3 (bucket: my-datasets, region: us-east-1)
Sync tool: aws-cli (detected at /usr/local/bin/aws)
Remote layout: content-addressable
Tracked files: 12 (.yref files found)
Stat cache: 12 entries, 0 stale
Issues: none
```

Checks: backend reachability, sync tool availability and configuration, credential
validity, `.yref` consistency.

### `blobsy config`

Get or set configuration values:

```bash
$ blobsy config [key] [value]    # get/set
$ blobsy config backend          # show current backend
```

### Command Summary

```
SETUP
  blobsy init                          Initialize blobsy in a git repo
  blobsy config [key] [value]          Get/set configuration
  blobsy doctor                        Diagnose configuration and connectivity

TRACKING
  blobsy track <path>                  Start tracking a file or directory
  blobsy untrack <path>                Stop tracking, move .yref to trash

SYNC
  blobsy sync [path...]                Bidirectional: push missing + pull missing
  blobsy push [path...]                Upload local blobs to remote
  blobsy pull [path...]                Download remote blobs to local
       [--force]                     Overwrite local modifications
  blobsy status [path...]              Show state of all tracked files (offline)

VERIFICATION
  blobsy verify [path...]              Verify local files match ref hashes

MAINTENANCE
  blobsy gc [--dry-run]                Remove unreferenced remote blobs
       [--older-than <duration>]     Only remove blobs older than <duration>
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
  layout: content-addressable

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
    prefix: project-v1/
    region: us-east-1

remote:
  layout: content-addressable    # default | timestamp

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
A non-zero exit code is treated as a transfer failure for that file.
stdout is discarded; stderr is shown to the user on failure.

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

**External tools (aws-cli, rclone):** Handle atomic writes internally.
Downloaded files are written atomically via temp-file-then-rename.

**Built-in `@aws-sdk` engine:** Blobsy must implement temp-file-then-rename for:

- Local file writes during pull (avoid partial files on interrupt).
- `.yref` file updates.
- Stat cache writes.

Temp files use the pattern `.blobsy-tmp-*` in the same directory as the target file.
`blobsy doctor` reports orphaned temp files.
On startup or via `blobsy clean`, orphaned temp files are removed.

**Interrupted operations:** If push or pull is interrupted midway, re-running is safe.
Already-transferred files are detected via hash comparison and skipped.
Per-file atomicity ensures no corrupt partial files.

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
| (none) | (none) | old | **Orphaned remote** | (not shown) | `gc` candidate |

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
that file’s `.yref`:

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

No custom resolution tooling needed.
Every developer already knows how to resolve git conflicts.

### Single-Writer Model (V1)

Blobsy assumes one writer per tracked file at a time.
This is the common case: each developer works on their own files.
Content-addressable storage means concurrent pushes of different files never interfere
-- different content hashes produce different remote keys.

If two users push the same content for the same file, they write the same key
(idempotent PUT). If they push different content, both blobs exist in the remote; the
git merge of `.yref` files determines which one wins.

### Comparison to Original Design Conflict Model

| Scenario | Original design (manifests) | Per-file ref (this design) |
| --- | --- | --- |
| A modifies X, B modifies Y | Maybe auto-merge (depends on manifest) | Auto-merge (always -- different `.yref` files) |
| A modifies X, B modifies X | Remote manifest conflict + pointer conflict | Git conflict on `X.yref` only |
| A adds X, B adds Y | Auto-merge | Auto-merge (always) |
| A deletes X, B modifies X | Complex (manifest + pointer) | Git conflict on `X.yref` |
| Resolution tool | `blobsy resolve` (custom) | `git checkout --ours/--theirs` (standard) |

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

1. **GC paper trail.** `blobsy gc` can scan `.blobsy/trash/` to find remote blobs that
   were once tracked but are no longer referenced by any live `.yref`. Without the
   trash, GC would have to walk the entire git history to discover orphaned blobs.

2. **Undo safety net.** If you untrack something by mistake, the `.yref` is still in
   `.blobsy/trash/` (and in git history).
   You can recover it.

### GC Cleans the Trash

`blobsy gc` removes trash entries whose remote blobs have been cleaned up.
Trash entries whose blobs are still referenced by other live `.yref` files on other
branches are kept until those references are also gone.

### What `.blobsy/` Does Not Contain

- **No config.** Config lives in `.blobsy.yml` files (hierarchical, placed anywhere).
- **No cache.** Caches (stat cache, hash cache) live outside git, e.g.,
  `~/.cache/blobsy/` or a local-only gitignored cache.
- **No manifests.** There are no manifests.

The `.blobsy/` directory is small and focused: just the trash.

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

Detection: `blobsy pull` errors with “missing (no remote!)”. In CI,
`blobsy verify --remote` (or a `check-remote` variant) can catch this before merge.

**Pushed data, then switched branches without committing.** User runs `blobsy push` on
branch A, then `git checkout B` without committing the updated ref.
The ref update is lost.
The data is in the remote but nothing in git references it.

Recovery: switch back to branch A; the uncommitted ref changes may still be in the
working tree. If lost, re-run `blobsy track` then `blobsy push`.

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
Use `blobsy gc --older-than 30d` to retain history for a reasonable period.

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

### Idempotency

All commands are safe to run repeatedly:

- `blobsy pull` when already up-to-date: no-op.
- `blobsy push` when remote matches: no-op.
- `blobsy track` on already-tracked path: updates ref if content changed, no-op if
  unchanged.
- `blobsy sync` when fully synced: no-op.

### Non-Interactive by Default

All sync operations (`push`, `pull`, `sync`, `status`, `verify`, `gc`) are fully
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

### No Daemon

Pure CLI. Each invocation reads ref files and config from disk, does work, updates ref
files, exits. No background processes, no lock files.
The only persistent local state is the stat cache, which is a pure optimization -- if
missing, all operations still work correctly, just slower.

### Testing

The `local` backend makes testing trivial.
Integration tests use a temp directory as the “remote.”
No cloud account needed for development.

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
- Content-addressable garbage collection
- Hierarchical `.blobsy.yml` configuration with externalization and compression rules
- Per-file gitignore management
- Machine-readable `--json` output for agents
- `blobsy doctor` for diagnostics
- Full file versioning via git history of `.yref` files

### What blobsy does not do (V1)

- Sub-file delta sync (whole-file granularity only)
- Cross-repo deduplication
- Multi-writer merge logic (single-writer model; git handles ref conflicts)
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

- **Advanced GC strategies.** Branch-aware retention policies, age-based remote cleanup.

- **Multi-backend routing.** Routing different directories to different backends.

- **Dictionary compression.** zstd dictionary training for 2-5x improvement on small
  files sharing structure.

- **Sub-file delta sync.** Transfer only changed portions of large files.

- **Remote staleness detection via provider hashes.** Store ETag/CRC from upload
  responses for cheap `HeadObject`-based checks.

- **Export/import specification.** `blobsy export` / `blobsy import` for tar.zst
  archives (offline sharing, backup, migration).

## What This Design Eliminates

From the original design, the following concepts are no longer needed:

- **Manifests** (remote or inline) -- gone entirely.
  Git is the manifest.
- **Directory pointer type** -- no `type: directory`, just files.
- **`manifest_sha256`** -- no manifest to hash.
- **Namespace prefixes / branch isolation** -- content-addressable dedup replaces branch
  prefixes. No `branches/{branch}` namespace mode.
- **`blobsy commit`** -- `blobsy track` handles hashing (idempotent: track + update).
- **`blobsy resolve`** -- standard git conflict resolution works.
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
| `blobsy-mlv9` | R3 P0-3 | `manifest_sha256` for directory pointers | **Eliminated.** No manifests, no directory pointers. Each file has its own `.yref` with its own `sha256`. Git diff is meaningful per-file. |
| `blobsy-a64l` | R3 P0-2 | Post-merge promotion workflow | **Eliminated.** Content-addressable blobs are not prefix-bound. After merge, `.yref` files on main point to the same blobs that were pushed from the feature branch. No promotion needed. |
| `blobsy-05j8` | R3 P0-4.2 | Delete semantics contradiction | **Eliminated.** Content-addressable storage never deletes or overwrites during sync. Old blobs remain until GC. No delete flags needed for push/pull. |
| `blobsy-7h13` | R1 C2, R3 P0-4 | Single-file remote conflict detection | **Eliminated.** No “remote hash Z” needed. Conflicts are git conflicts on `.yref` files, resolved with standard git tools. Content-addressable = concurrent pushes of different content produce different keys (no overwrite). |
| `blobsy-lsu9` | R3 P0-5 | Compression + transfer mechanics | **Resolved.** File-by-file orchestration (compress -> copy -> cleanup). Transfer tools used as copy engines, not diff engines. No staging directory needed. Compression is V1 via Node.js built-in `node:zlib`. |

### Resolved in Spec (Carried Forward)

These issues were resolved in the original spec and remain resolved in this design.

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-suqh` | R1 C3, R3 4.9 | Interactive init contradiction | **Resolved.** `init` is interactive without flags; all sync ops are non-interactive. See Non-Interactive by Default. |
| `blobsy-br1a` | R1 C4, R3 5 | `blobsy sync` bidirectional danger | **Simplified.** Sync = push missing + pull missing. No delete cascades. No `--strategy` flag in V1. |
| `blobsy-jlcn` | R1 M1, R3 4.1 | Pointer field types | **Resolved.** sha256 = 64-char lowercase hex, size = bytes. See Ref File Format. |
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
| `blobsy-rel2` | R3 4.5 | Atomic writes for built-in transport | **Addressed.** Temp-file-then-rename for built-in SDK. See Atomic Writes section. |
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
