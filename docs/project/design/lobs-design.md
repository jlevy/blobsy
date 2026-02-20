# lobs: Large Object Storage for Git Repos

**Status:** Draft

**Date:** 2026-02-18

A standalone CLI for namespace-based sync of large files and directories between local
gitignored paths and remote storage, with committed pointer files for tracking.

## Goals and Principles

1. **Simple:** Simple usage is easy.
   `lobs track`, `lobs push`, `lobs pull`. No configuration required for the common case
   beyond a backend URL.

2. **CLI only:** No daemon, no server, no GUI. Pure stateless CLI that reads pointer
   files, does work, exits.

3. **Self-documenting:** Humans and agents learn to use it by running it.
   Every `.lobs` file has a header comment explaining what it is and how to get help.
   Rich `--help` on every command.
   `--json` output for agents.
   Works well as a skill in agent toolchains.

4. **Customizable with sensible defaults:** Hierarchical config at file, directory,
   repo, and home folder levels.
   Zero config needed for common cases; full control available when needed.

5. **Flexible:** Works with any file types, any directory structures.
   No renaming of files or directories.
   Just gitignore the target and put a `.lobs` file next to it.
   With or without compression.
   With or without checksumming.

6. **Infrastructure neutral:** Pluggable backend (S3, R2, local, custom command),
   pluggable sync engine (aws-cli, rclone, built-in), pluggable compression (zstd, gzip,
   none, custom), pluggable namespace modes.

7. **Transparent storage format:** Remote storage mirrors local directory structure,
   organized under namespaces.
   Files stored as-is or individually compressed.
   Browsable with standard tools (`aws s3 ls`, web console).
   No opaque databases or content-addressed hash stores.

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

### Manifest + S3 Sync (Custom)

Custom implementations using a JSON manifest plus S3 objects.

- **Relevant:** Simple, transparent, works with any S3-compatible store.
- **Gaps:** Each team builds their own.
  No standard format, no reusable CLI.

### Assessment

No existing tool combines: committed pointer files for git integration, pluggable
backends, pluggable compression, namespace-based branch isolation, push/pull sync,
transparent remote storage layout, and a simple standalone CLI. `lobs` fills this gap as
a namespace-based sync coordinator that delegates heavy lifting to existing tools.

## Core Concepts

### The `.lobs` Convention

For every tracked file or directory, a `.lobs` pointer file sits adjacent to it with the
same name plus `.lobs` appended:

```
data/prices.parquet           <- actual data (gitignored)
data/prices.parquet.lobs      <- pointer file (committed to git)

data/research-batch/          <- actual directory (gitignored)
data/research-batch.lobs      <- pointer file (committed to git)
```

The `.lobs` file is committed to git.
The actual data is gitignored.
`lobs` manages `.gitignore` entries automatically.

### Namespace Modes

The core versioning problem: gitignored files don’t travel with branch checkouts.
If you push data on `feature-x`, switch to `main`, and push different data, you
overwrite the remote copy.
Namespaces solve this by organizing remote storage into isolated segments.

The namespace mode determines the remote path prefix under which data is stored:

| Mode | Remote prefix | Use case |
| --- | --- | --- |
| `branch` (default) | `branches/<branch>/` | Branch-isolated data. Each branch has its own copy. |
| `fixed` | `fixed/` | One shared namespace. All branches read/write the same data. |
| `version` | `versions/<id>/` | Explicit versioning. Set via `--version` flag or config. |

**Namespace mode is set in config and can be overridden per-pointer.** The resolved
namespace (the actual prefix used) is computed at runtime, not stored in the pointer
file.
This keeps pointer files stable across branches — the same `.lobs` file resolves to
different remote paths depending on the current branch.

**`branch` mode (default):**
- Resolves the current Git branch name at runtime.
- Detached HEAD falls back to `detached/<sha>/` using the first 12 characters of the
  commit SHA (balances collision resistance with readability).
- Each branch gets isolated remote storage.
- Switching branches and running `lobs pull` materializes that branch's data.

**`fixed` mode:**
- Ignores the Git branch entirely.
- All branches share one remote copy.
- Appropriate for reference data, shared models, or simple single-branch workflows.

**`version` mode:**
- Uses an explicit version identifier.
- Set via `lobs push --version v2.1` or `namespace.version` in config.
- For pinning data to a release, experiment run, or other explicit identifier.

#### Remote Storage Layout

With `branch` namespace mode (default):

```
s3://bucket/prefix/
  branches/main/
    data/prices.parquet.zst
    data/research-batch/
      .lobs-manifest.json
      report.md.zst
      raw/response.json.zst
  branches/feature-x/
    data/prices.parquet.zst
    data/research-batch/
      ...
```

With `fixed` namespace mode:

```
s3://bucket/prefix/
  fixed/
    data/prices.parquet.zst
    data/research-batch/
      ...
```

With `version` namespace mode:

```
s3://bucket/prefix/
  versions/v2.1/
    data/prices.parquet.zst
    ...
```

Browsable with `aws s3 ls`, web consoles, or any S3 tool.
No opaque hash-based storage.
When compression is `none`, files are stored as-is with their original names.

### Pointer File Format

Every `.lobs` file starts with a self-documenting comment header, followed by YAML.
Pointer files use stable key ordering (keys are always written in the order shown below)
to minimize noise in `git diff`.

**Field types and encoding:**
- `sha256`: 64-character lowercase hexadecimal string.
- `size`, `total_size`, `file_count`: integer, in bytes (for sizes).
- `updated`: ISO 8601 UTC timestamp with `Z` suffix (e.g., `2026-02-18T12:00:00Z`).
- `compression`: one of `zstd`, `gzip`, `lz4`, `none`.

**Format versioning:** The `format` field uses `<name>/<major>.<minor>` versioning
(e.g., `lobs/0.1`).
Compatibility policy: reject if major version is unsupported; warn if minor version is
newer than the running lobs version supports.
The same policy applies to `lobs-manifest/<major>.<minor>` in manifest files.

**Single file pointer:**

```yaml
# This is a large object reference file.
# Run npx lobs@latest --help for more on using lobs.

format: lobs/0.1
type: file
sha256: 7a3f0e...
size: 15728640
compression: zstd
updated: 2026-02-18T12:00:00Z
```

**Directory pointer:**

```yaml
# This is a large object reference file.
# Run npx lobs@latest --help for more on using lobs.

format: lobs/0.1
type: directory
manifest: true
compression: zstd
updated: 2026-02-18T12:00:00Z
```

**Pointer with per-file overrides:**

```yaml
# This is a large object reference file.
# Run npx lobs@latest --help for more on using lobs.

format: lobs/0.1
type: file
sha256: abc123...
size: 4294967296
compression: none              # Override: skip compression for this file
namespace_mode: fixed          # Override: share this file across all branches
updated: 2026-02-18T12:00:00Z
```

The `remote` path is not stored in the pointer by default.
Convention derives it: the namespace prefix plus the data’s repo-relative path, under
the configured backend prefix.
An explicit `remote:` field overrides the convention when needed.

### Integrity Model

**Transfer integrity** is handled by the transport layer.
S3 verifies uploads via ETags and supports `x-amz-checksum-sha256` natively.
`aws s3 sync` and `rclone` verify transfers internally.
Lobs does not re-implement transfer verification.

**Change detection and at-rest verification** are handled by lobs via SHA-256 hashes:

**Single files:** The pointer always includes `sha256` and `size`. One hash for one file
is cheap and enables:
- Local integrity verification without network access (`lobs verify`)
- Change detection independent of mtime (which git checkout doesn't preserve)
- Clear signal in `git diff` when data actually changed vs.
  just a timestamp update

**Directories (with manifest):** Per-file SHA-256 hashes stored in the remote manifest.
Enables accurate change detection during push and pull, and `lobs verify` for
directories.

When using the built-in `@aws-sdk` transfer engine, hashes are computed during the upload
read (single I/O pass).
When delegating to external tools (aws-cli, rclone), hashing requires a separate read
pass — the file is read once to hash, then the external tool reads it again to transfer.
In practice the OS page cache makes the second read nearly free, and the stat cache
(below) ensures only changed files are hashed at all.

Hashing during push is critical for the core branch-switching workflow: `git checkout`
resets mtime on every file, so without content hashes, `lobs push` after a branch switch
would re-upload everything.
With manifest hashes, push correctly identifies unchanged files and skips them.

**Directories (without manifest):** Change detection delegated entirely to the transport
tool. `lobs verify` is not available.

Configurable via `checksum.algorithm`: `sha256` (default), `none` (skip hashing, rely
entirely on transport tool's own change detection).

When checksum is `none`, lobs trusts the sync tool entirely.
The `.lobs` file becomes just a marker that says "this path is externally synced."
Manifest files will store `size` only, and change detection falls back to size
comparison.

For independent verification outside of lobs, SHA-256 is available everywhere:
- macOS: `shasum -a 256 <file>`
- Linux: `sha256sum <file>`
- Windows: `Get-FileHash <file> -Algorithm SHA256`

### Local Stat Cache

Lobs maintains a local stat cache at `.lobs/cache/stat-cache.json` (gitignored) that
stores the last-known `size`, `mtime_ms`, and `sha256` for each tracked file.
This follows the same approach as git's index: use filesystem metadata as a fast-path to
avoid re-hashing unchanged files.

**How it works:**
1. On push or verify, lobs calls `stat()` on each local file.
2. If `size` and `mtime_ms` match the cached entry, the cached `sha256` is trusted
   (file assumed unchanged — no read or hash needed).
3. If either differs, lobs reads and hashes the file, then updates the cache.

**Why mtime is safe here but not in the manifest:** The stat cache is local and
per-machine.
It only compares a file's current mtime against the mtime recorded *on the same machine*
after the last hash.
This is a "definitely changed" signal — if mtime changed, something touched the file.
The remote manifest cannot use mtime because different machines, git checkouts, CI
runners, and Docker builds all produce different mtimes for the same content.

**High-resolution timestamps:** Node.js `fs.stat()` provides `mtimeMs` (millisecond
float) on all platforms.
Millisecond resolution is sufficient for lobs — sub-millisecond file modifications
between cache writes are unlikely in practice.
(Git uses nanosecond timestamps with a "racily clean" detection fallback for the
pathological case; lobs can add this if needed, but milliseconds are adequate for V1.)

**Performance impact:** `stat()` costs ~1-5 microseconds per file.
For a directory with 1,000 files, the stat pass takes ~5 ms.
Without the cache, every push would read and hash all 1,000 files
(~seconds to minutes depending on sizes).
With the cache, only files whose stat data changed are hashed.

| Scenario (1000 files, 10 MB avg) | Without stat cache | With stat cache |
| --- | --- | --- |
| First push | Hash all: ~20s | Hash all: ~20s (same) |
| Second push, 3 files changed | Hash all: ~20s | Stat all + hash 3: ~65ms |
| After `git checkout` (mtime reset on all) | Hash all: ~20s | Stat all + hash all: ~20s |

**Cache invalidation:** The cache is a pure optimization.
If missing or corrupted, lobs falls back to hashing all files (correct but slower).
The cache is never shared across machines — it is gitignored and machine-local.

### Manifests

Manifests track the contents of directory targets.
They are stored remotely at a convention path alongside the data, not in the committed
pointer file.

**Location:** `<namespace>/<repo-path>/.lobs-manifest.json` (e.g.,
`branches/main/data/research-batch/.lobs-manifest.json`)

**Format (JSON):**

Manifests use canonical serialization: keys in fixed order, file entries sorted by `path`
(lexicographic, forward-slash separated), consistent newlines (LF), no trailing
whitespace. This ensures the same logical manifest always produces the same bytes,
which is required for stable `manifest_sha256` computation.

```json
{
  "format": "lobs-manifest/0.1",
  "updated": "2026-02-18T12:00:00Z",
  "files": [
    {
      "path": "raw/response.json",
      "size": 1048576,
      "sha256": "b4c8d2...",
      "stored_as": "raw/response.json.zst"
    },
    {
      "path": "report.md",
      "size": 4096,
      "sha256": "7a3f0e...",
      "stored_as": "report.md.zst"
    }
  ],
  "total_size": 1052672
}
```

**Sync role:** On `push`, lobs rewrites the remote manifest after uploading files.
On `pull`, lobs fetches the manifest first, then materializes local files.
The manifest is the sync coordination mechanism — it records what exists in the remote
namespace.

**When manifests are enabled:**
- `pull` knows what to download without listing the entire remote prefix
- `push` can detect new/changed/deleted files by comparing local state to manifest
- `status` can show what’s available remotely without a network listing
- Single-writer conflict detection: if the remote manifest changed since last pull, fail

**Default:** `manifest: true` for directories.
The manifest is remote-only (not committed to git), so it creates no git noise.
It’s small (JSON, not YAML), and it enables smarter sync without imposing cost on the
git history.

Opt out with `manifest: false` in config or per-pointer.
When disabled, sync is delegated entirely to the transport tool’s own change detection.

### Gitignore Management

When `lobs track` is run, the CLI adds the target path to the `.gitignore` file in the
same directory as the tracked path (following the DVC convention).
This keeps gitignore entries co-located with the things they ignore.
If no `.gitignore` exists in that directory, one is created.

Entries are placed in a clearly marked section:

```gitignore
# >>> lobs-managed (do not edit) >>>
data/prices.parquet
data/research-batch/
# <<< lobs-managed <<<
```

`lobs untrack` removes the entry.
The section markers prevent accidental edits and make it easy for the CLI to manage
entries idempotently.

## Configuration

### Hierarchy

Four levels, each overriding the one above:

```
~/.config/lobs/config.yml          Global defaults
<repo>/.lobs/config.yml            Repo-level
<repo>/subdir/.lobs/config.yml     Directory-level override
<repo>/subdir/file.parquet.lobs    Per-file (inline overrides)
```

Resolution is bottom-up: per-file settings win over directory, directory over repo, repo
over global.

### Repo-Level Config (Minimum Viable)

```yaml
# .lobs/config.yml
backend: default

backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: project-v1/
    region: us-east-1
```

This is all that’s needed.
Everything else has sensible defaults.

### Full Config Options

```yaml
# .lobs/config.yml
backend: default

backends:
  default:
    type: s3
    bucket: my-datasets
    prefix: project-v1/
    region: us-east-1
    endpoint: null              # Custom endpoint (for R2, MinIO, etc.)

  r2:
    type: s3                    # R2 is S3-compatible; use type: s3 with endpoint
    endpoint: https://ACCT_ID.r2.cloudflarestorage.com
    bucket: my-r2-data

  dev:
    type: local
    path: /tmp/lobs-test-remote/

  custom:
    type: command
    push: "my-upload {local} {remote}"
    pull: "my-download {remote} {local}"

namespace:
  mode: branch                 # branch (default) | fixed | version
  # version: "v1.0"           # Required when mode is 'version'

compression:
  algorithm: zstd              # zstd | gzip | lz4 | none | command
  level: 3
  skip_extensions:             # Don't compress already-compressed formats
    - .jpg
    - .png
    - .pdf
    - .gz
    - .zip
    - .zst
    - .mp4
  # Custom compression:
  # compress_cmd: "zstd -3 -o {output} {input}"
  # decompress_cmd: "zstd -d -o {output} {input}"

sync:
  tool: auto                   # auto | aws-cli | rclone | built-in
  parallel: 8
  # 'auto' resolution order:
  #   1. aws cli (if available and backend is s3-type)
  #   2. rclone (if available)
  #   3. built-in (@aws-sdk/client-s3)

checksum:
  algorithm: sha256            # sha256 (default) | none

manifest: true                 # true (default) to enable remote manifests for directories

ignore:                          # Gitignore-style patterns for directory tracking
  - "__pycache__/"
  - "*.pyc"
  - ".DS_Store"
```

### Ignore Patterns (Directory Tracking)

When tracking a directory, lobs syncs all files within it by default.
Ignore patterns let you exclude specific files or subdirectories from lobs management,
so they remain local-only or in git.

Ignore patterns use gitignore syntax, evaluated relative to the tracked directory root.
They participate in the standard config hierarchy:

```
~/.config/lobs/config.yml          Global ignore defaults (e.g., __pycache__/, .DS_Store)
<repo>/.lobs/config.yml            Repo-level ignores
<repo>/data/analysis/.lobs/config.yml   Directory-level ignores (specific to this target)
```

Resolution is bottom-up, same as all other config.
Directory-level ignores override repo-level ignores.

Ignore patterns only apply to directory targets.
They have no effect on single-file pointers (a single tracked file is either tracked or
not).

**Example:** A `data/analysis/` directory contains `.parquet` files (large, should be in
lobs) and `.py` scripts and `.md` files (small, should be in git):

```yaml
# data/analysis/.lobs/config.yml
ignore:
  - "*.py"
  - "*.md"
  - "*.txt"
  - "scripts/"
```

With this config, `lobs push data/analysis/` syncs only the non-ignored files (the
`.parquet` files and anything else not matching the patterns).
The ignored files remain in git.

Patterns can be as specific as needed — exact filenames, directory paths, or glob
patterns:

```yaml
ignore:
  - "README.md"              # Specific file
  - "scripts/"               # Entire subdirectory
  - "*.py"                   # All Python files
  - "temp/*.log"             # Logs in a specific subdirectory
```

**Gitignore interaction for mixed directories:** When ignore patterns are used, the
tracked directory contains a mix of lobs-managed and git-managed files.
The user is responsible for managing `.gitignore` entries for the lobs-managed files
within the directory (e.g., adding `data/analysis/*.parquet` to `.gitignore`).
`lobs track` adds the directory to `.gitignore` by default; when ignore patterns are
present, lobs warns that the user should adjust `.gitignore` to exclude only the
lobs-managed files, not the entire directory.

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
Escape hatch for unsupported backends.
Template variables:
- `{local}` — absolute path to the local file or directory.
- `{remote}` — full remote key (e.g., `branches/main/data/prices.parquet.zst`).
- `{relative_path}` — repo-relative path of the tracked target (e.g.,
  `data/prices.parquet`).
- `{namespace}` — resolved namespace prefix (e.g., `branches/main/`).
- `{bucket}` — the configured bucket name.

The command runs once per file (not once per push operation).
A non-zero exit code is treated as a transfer failure for that file.
stdout is discarded; stderr is shown to the user on failure.

### S3-Compatible Backends

R2, MinIO, Backblaze B2, Tigris, and other S3-compatible stores all use the same
`type: s3` backend with a custom endpoint.
The AWS CLI and rclone support `--endpoint-url` for this.
`@aws-sdk/client-s3` supports custom endpoints via its client configuration object:

```bash
# R2 via AWS CLI (what lobs does internally)
aws s3 sync ./local/ s3://bucket/prefix/branches/main/ \
  --endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com

# rclone also works natively with R2 and other S3-compatible stores
```

There is no separate R2 backend type.
Cloudflare’s own `wrangler r2` CLI exists but is less mature for bulk operations.
The AWS CLI + endpoint approach is standard practice.

### Transfer Delegation

`lobs` does not implement high-performance transfers.
It delegates:

| `sync.tool` | How transfers work |
| --- | --- |
| `aws-cli` | Shells out to `aws s3 cp` / `aws s3 sync` with appropriate flags |
| `rclone` | Shells out to `rclone copy` / `rclone sync` |
| `built-in` | Uses `@aws-sdk/client-s3` directly (slower, but zero external deps) |
| `auto` | Tries aws-cli, then rclone, then built-in |

For directory targets, `aws s3 sync` and `rclone sync` handle incremental transfers
natively -- only changed files are transferred.

### Symlinks

`lobs` inherits symlink behavior from the underlying transport tool.
It does not implement its own symlink handling.

In practice this means: symlinks are followed on push (the content is uploaded), and
regular files are written on pull (S3 and other object stores have no symlink concept).
Symlink metadata is not preserved across the remote.
This matches the default behavior of `aws s3 sync` and `rclone --copy-links`.

Users who need different behavior can pass flags to the underlying transport via the
`sync.extra_flags` config:

```yaml
sync:
  tool: aws-cli
  extra_flags: "--no-follow-symlinks"    # skip symlinks entirely
```

Or with rclone:

```yaml
sync:
  tool: rclone
  extra_flags: "--links"    # preserve symlinks as .rclonelink files
```

### Authentication

No custom auth mechanism.
Uses the standard credential chain for the backend:
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Shared credentials file (`~/.aws/credentials`)
- Instance profiles / IAM roles
- rclone config (when `sync.tool: rclone`)

## Compression System

### Per-File Compression

Files are compressed before upload and decompressed after download.
The user never sees compressed files locally.

Default: `zstd` at level 3 (fast compression, ~3x ratio on text, 800+ MB/s
decompression).

Skip list: Already-compressed formats (JPEG, PNG, PDF, gzip, zip, zstd, MP4) are stored
as-is. Compressing them wastes CPU for negligible gain.
The skip list (`compression.skip_extensions`) must be set in repo-level config (committed
to git), not in global/user config, because it affects remote storage keys. If two users
have different skip lists, they would produce different remote representations of the same
directory, breaking sync.

Remote filenames: Compressed files get a `.zst` suffix (or `.gz`, `.lz4` depending on
algorithm). The pointer file tracks both the original filename and the compressed remote
filename.

### Pluggable Algorithms

| Algorithm | Default Level | Best For |
| --- | --- | --- |
| `zstd` | 3 | General purpose (default). Fast, good ratio. |
| `gzip` | 6 | Maximum compatibility. |
| `lz4` | - | Speed-critical. Low ratio but extremely fast. |
| `none` | - | Already-compressed data, or when simplicity matters. |
| `command` | - | Custom: specify `compress_cmd` and `decompress_cmd`. |

### Archive Export

Separate from sync. `lobs export` produces a `tar.zst` archive of tracked files for
offline sharing, backup, or migration.
`lobs import` restores from an archive.
Uses high compression (zstd level 19).

## CLI Design

### Commands

```
SETUP
  lobs init                          Initialize lobs in a git repo
                                     Creates .lobs/config.yml, updates .gitignore
  lobs config [key] [value]          Get/set configuration
  lobs backend add <name>            Add a backend
  lobs backend ls                    List configured backends

TRACKING
  lobs track <path> [--backend B]    Start tracking a file or directory
       [--no-manifest]               Creates .lobs pointer, adds to .gitignore
  lobs untrack <path>                Stop tracking, remove pointer and gitignore entry
  lobs ls [--json]                   List all tracked paths with sync status

SYNC
  lobs push [path...]                Upload local changes to remote namespace
       [--version <id>]              Override namespace for this push
  lobs pull [path...]                Download from remote namespace to local
       [--force]                     Overwrite local modifications
  lobs status [path...]              Show what's changed locally vs remotely
  lobs diff [path...]                Preview what push/pull would transfer

NAMESPACE MANAGEMENT
  lobs ns ls                         List all remote namespaces with sizes
  lobs ns show                       Show current resolved namespace
  lobs gc [--dry-run]                Remove namespaces with no corresponding local branch
       [--older-than <duration>]     Only remove namespaces not updated in <duration>

UTILITIES
  lobs verify [path...]              Verify local files match pointer hashes
  lobs cache info                    Show storage statistics
  lobs export [path...] -o FILE      Export tracked files as tar.zst archive
  lobs import FILE                   Import from archive
```

Without path arguments, sync commands operate on all tracked paths in the repo.
With paths, they operate on the specified subset only.

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
2   Conflict (remote manifest changed during operation)
```

### Example Session

This session shows single-user setup and basic operations.
See **Usage Scenarios** below for multi-user collaboration walkthroughs.

```bash
# Initialize in a repo
$ lobs init
Created .lobs/config.yml
? Default backend type: s3
? Bucket: my-datasets
? Prefix: project-v1/
? Region: us-east-1
Namespace mode: branch (default)

# Track a large file
$ lobs track data/prices.parquet
Created data/prices.parquet.lobs
Added data/prices.parquet to .gitignore

# Track a directory (manifest enabled by default)
$ lobs track data/research-batch/
Created data/research-batch.lobs (manifest enabled)
Added data/research-batch/ to .gitignore

# Track shared reference data (fixed namespace, no branch isolation)
$ lobs track data/shared-models/ --namespace-mode fixed
Created data/shared-models.lobs (namespace: fixed, manifest enabled)
Added data/shared-models/ to .gitignore

# Check current namespace
$ lobs ns show
Namespace mode: branch
Resolved: branches/main/

# Check status
$ lobs status
  Namespace: branches/main/
  data/prices.parquet       local-only  15.0 MB
  data/research-batch/      local-only  (directory, manifest)
  data/shared-models/       local-only  (directory, manifest, namespace: fixed)

# Push to remote
$ lobs push
Pushing data/prices.parquet -> branches/main/ (15.0 MB -> 5.2 MB compressed)...
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
Pushing data/shared-models/ -> fixed/ (syncing directory)...
Done. 3 targets pushed.

# Switch branches and pull
$ git checkout feature-x
$ lobs pull
Namespace: branches/feature-x/
Pulling data/prices.parquet (not in namespace, skipping)...
Pulling data/research-batch/ (not in namespace, skipping)...
Pulling data/shared-models/ <- fixed/ (already up-to-date)...
Done.

# Push data on the feature branch (creates new namespace)
$ lobs push
Pushing data/prices.parquet -> branches/feature-x/ (15.0 MB -> 5.2 MB)...
Pushing data/research-batch/ -> branches/feature-x/ (syncing directory)...
Pushing data/shared-models/ -> fixed/ (already up-to-date)...
Done.

# List all namespaces
$ lobs ns ls
  branches/main/           3 targets   120.4 MB   updated 2026-02-18
  branches/feature-x/      2 targets    20.2 MB   updated 2026-02-18
  fixed/                   1 target     45.0 MB   updated 2026-02-18

# Another machine: pull
$ lobs pull
Pulling data/prices.parquet (5.2 MB compressed)...
Pulling data/research-batch/ (syncing directory)...
Done. 3 targets pulled.

# Incremental push after local changes
$ lobs push data/research-batch/
Syncing data/research-batch/ -> branches/main/ ...
  3 files changed, 1 new, 0 deleted
Done.
```

## Usage Scenarios

The example session above shows single-user setup and sync.
These scenarios show multi-user collaboration — the primary use case for lobs.

### Scenario 1: Single Large File

A team shares a large data file via lobs.
One user sets it up, others pull and contribute changes.

**User 1 sets up tracking:**

```bash
# Initialize lobs in the repo (one-time)
$ lobs init
Created .lobs/config.yml
? Bucket: team-datasets
? Prefix: my-project/
? Region: us-east-1

# Track a large file
$ lobs track data/prices.parquet
Created data/prices.parquet.lobs
Added data/prices.parquet to .gitignore

# Push the data to remote storage
$ lobs push
Pushing data/prices.parquet -> branches/main/ (15.0 MB -> 5.2 MB compressed)...
Done. 1 target pushed.

# Commit the pointer file and config to git
$ git add .lobs/config.yml data/prices.parquet.lobs .gitignore
$ git commit -m "Track prices.parquet with lobs"
$ git push
```

At this point, the git repo contains the pointer file and config.
The actual data lives in remote storage.

**User 2 joins and pulls the data:**

```bash
# Pull the latest git changes — sees the new .lobs pointer
$ git pull
# New files: .lobs/config.yml, data/prices.parquet.lobs, .gitignore

# Check what lobs tracks and what's out of sync
$ lobs status
  Namespace: branches/main/
  data/prices.parquet       missing     (remote: 15.0 MB)

# Pull the data
$ lobs pull
Pulling data/prices.parquet (5.2 MB compressed -> 15.0 MB)...
Done. 1 target pulled.

# The file is now materialized locally
$ ls -lh data/prices.parquet
-rw-r--r--  1 user2  staff  15M Feb 18 12:00 data/prices.parquet
```

**User 2 makes a change and pushes:**

```bash
# After modifying the file locally...
$ lobs status
  Namespace: branches/main/
  data/prices.parquet       modified    15.0 MB -> 16.1 MB

# Push the updated file
$ lobs push
Pushing data/prices.parquet -> branches/main/ (16.1 MB -> 5.5 MB compressed)...
Done. 1 target pushed.

# The pointer file was updated by push — commit it
$ git add data/prices.parquet.lobs
$ git commit -m "Update prices data"
$ git push
```

**Users 1 and 3 see the change and sync:**

```bash
# Pull git changes — sees the updated pointer
$ git pull
# Updated: data/prices.parquet.lobs (sha256 changed)

# Status shows local data is stale
$ lobs status
  Namespace: branches/main/
  data/prices.parquet       stale       (local: 15.0 MB, remote: 16.1 MB)

# Pull when ready
$ lobs pull
Pulling data/prices.parquet (5.5 MB compressed -> 16.1 MB)...
Done. 1 target pulled.
```

**Key points:**
- The `.lobs` pointer in git is the coordination signal — `git diff` shows when data
  changed.
- `lobs status` tells you whether your local data matches the pointer.
- Users only fetch large data when they choose to (`lobs pull`), not automatically.
- The workflow is always: `lobs push` then `git commit` the pointer, or `git pull` then
  `lobs pull` the data.

### Scenario 2: Directory of Files

Same multi-user collaboration, but with a directory containing many files.

**User 1 sets up tracking:**

```bash
# Track a directory (manifest enabled by default)
$ lobs track data/research-batch/
Created data/research-batch.lobs (manifest enabled)
Added data/research-batch/ to .gitignore

# Push all files in the directory
$ lobs push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  42 files, 120.4 MB total (78.2 MB compressed)
  Manifest written.
Done. 1 target pushed.

# Commit pointer to git
$ git add data/research-batch.lobs .gitignore
$ git commit -m "Track research-batch directory with lobs"
$ git push
```

**User 2 pulls and makes changes:**

```bash
$ git pull
$ lobs status
  Namespace: branches/main/
  data/research-batch/      missing     (remote: 42 files, 120.4 MB)

$ lobs pull
Pulling data/research-batch/ (syncing directory)...
  42 files downloaded (78.2 MB compressed -> 120.4 MB)
Done. 1 target pulled.

# User 2 adds new files and modifies an existing one
$ cp new-data.json data/research-batch/
$ vim data/research-batch/report.md

$ lobs status
  Namespace: branches/main/
  data/research-batch/      modified    (1 new, 1 changed, 0 deleted)

$ lobs push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  1 new, 1 changed, 0 deleted (2.1 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.lobs
$ git commit -m "Add new data and update report"
$ git push
```

**Key points (in addition to Scenario 1):**
- The remote manifest tracks directory contents, so incremental sync transfers only
  changed files.
- `lobs status` shows a summary of new/changed/deleted files within the directory.
- The pointer file’s `updated` timestamp changes on push, signaling a new version in
  git.

### Scenario 3: Mixed Directory (Selective Tracking)

A directory containing both large files (synced via lobs) and small files (committed to
git). Ignore patterns in the directory-level config control which files lobs manages.

**Example layout:**

```
data/analysis/
  model-weights.bin         120 MB  <- too large for git, lobs-managed
  embeddings.parquet         45 MB  <- too large for git, lobs-managed
  process.py                  3 KB  <- small, git-managed
  config.yaml                 1 KB  <- small, git-managed
  README.md                   2 KB  <- small, git-managed
  scripts/
    preprocess.py             4 KB  <- small, git-managed
    evaluate.py               5 KB  <- small, git-managed
```

**User 1 sets up selective tracking:**

```bash
# Track the directory
$ lobs track data/analysis/
Created data/analysis.lobs (manifest enabled)
Added data/analysis/ to .gitignore

# Configure ignore patterns for the small, git-managed files
$ mkdir -p data/analysis/.lobs
$ cat > data/analysis/.lobs/config.yml << 'EOF'
ignore:
  - "*.py"
  - "*.yaml"
  - "*.md"
  - "scripts/"
EOF

# Adjust .gitignore: don't ignore the whole directory, only the large files
# (Remove the blanket directory entry that lobs track created,
#  and add specific entries for lobs-managed files)
$ vim .gitignore
# Result: .gitignore now has specific entries like:
#   data/analysis/model-weights.bin
#   data/analysis/embeddings.parquet
# instead of:
#   data/analysis/

# Push — only non-ignored files are synced
$ lobs push
Pushing data/analysis/ -> branches/main/ (syncing directory)...
  2 files (model-weights.bin, embeddings.parquet), 165 MB (54.3 MB compressed)
  Manifest written.
Done. 1 target pushed.

# Commit everything to git: pointer, config, ignored small files, gitignore
$ git add data/analysis/.lobs/config.yml data/analysis.lobs .gitignore
$ git add data/analysis/process.py data/analysis/config.yaml data/analysis/README.md
$ git add data/analysis/scripts/
$ git commit -m "Track analysis directory with lobs (large files only)"
$ git push
```

**User 2 pulls:**

```bash
$ git pull
# Gets: pointer file, .lobs config with ignore patterns, all the small files
# Does NOT get: model-weights.bin, embeddings.parquet (gitignored, lobs-managed)

$ lobs status
  Namespace: branches/main/
  data/analysis/            missing     (remote: 2 files, 165 MB)
                            ignored: *.py, *.yaml, *.md, scripts/

$ lobs pull
Pulling data/analysis/ (syncing directory, 2 files matching)...
  model-weights.bin (120 MB), embeddings.parquet (45 MB)
Done. 1 target pulled.

# Now the directory is complete: large files from lobs, small files from git
$ ls data/analysis/
config.yaml  embeddings.parquet  model-weights.bin  process.py  README.md  scripts/
```

**Key points (in addition to Scenarios 1 and 2):**
- Ignore patterns use gitignore syntax, configured in the directory-level
  `.lobs/config.yml`.
- The config file is committed to git, so all team members share the same ignore
  patterns.
- `lobs status` shows both the tracked files and the active ignore patterns.
- `.gitignore` must be adjusted manually for mixed directories: ignore the lobs-managed
  files specifically, not the entire directory.
- Small files flow through git normally.
  Large files flow through lobs.
  Both live in the same directory.

### Scenario 4: Fixed Namespace (Shared Data)

Shared reference data — a model, a dataset, a set of fixtures — that every branch reads
and occasionally updates.
Uses `fixed` namespace mode: one copy in remote storage, no branch isolation, all users
and branches see the same data.

**User 1 sets up tracking with fixed namespace:**

```bash
# Track a shared model directory with fixed namespace
$ lobs track models/base-model/ --namespace-mode fixed
Created models/base-model.lobs (manifest enabled, namespace: fixed)
Added models/base-model/ to .gitignore

$ lobs ns show
Namespace mode: fixed
Resolved: fixed/

$ lobs push
Pushing models/base-model/ -> fixed/ (syncing directory)...
  5 files, 2.3 GB total (1.1 GB compressed)
  Manifest written.
Done. 1 target pushed.

$ git add models/base-model.lobs .gitignore
$ git commit -m "Track shared base model with lobs (fixed namespace)"
$ git push
```

**User 2 pulls on any branch — same data regardless of branch:**

```bash
$ git checkout feature/experiment-7
$ git pull origin main  # get the pointer file

$ lobs ns show
Namespace mode: fixed
Resolved: fixed/

# Fixed namespace — same remote location regardless of branch
$ lobs pull
Pulling models/base-model/ <- fixed/ (syncing directory)...
  5 files, 2.3 GB (1.1 GB compressed)
Done. 1 target pulled.
```

**CI pipeline pulls the same data:**

```bash
# CI is on main, but it doesn't matter — fixed namespace ignores the branch
$ lobs pull
Pulling models/base-model/ <- fixed/ ...
Done. 1 target pulled.
```

**User 1 updates the shared model (from any branch):**

```bash
# On main, or feature/experiment-7, or any branch — doesn't matter
$ cp retrained-model.bin models/base-model/model.bin

$ lobs status
  Namespace: fixed/
  models/base-model/        modified    (0 new, 1 changed, 0 deleted)

$ lobs push
Pushing models/base-model/ -> fixed/ (syncing directory)...
  1 changed (800 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add models/base-model.lobs
$ git commit -m "Update base model with retrained weights"
$ git push
```

**All users and CI see the update:**

```bash
# Any branch, any user, any environment
$ lobs status
  Namespace: fixed/
  models/base-model/        stale       (remote has newer version)

$ lobs pull
Pulling models/base-model/ <- fixed/ ...
  1 changed (800 MB transferred)
Done. 1 target pulled.
```

**Key points:**
- `fixed` namespace mode means one remote location (`fixed/`) shared by all branches.
  Switching branches does not change the namespace.
- Useful for reference data, shared models, common fixtures, or any data that shouldn’t
  diverge across branches.
- The workflow is simpler than `branch` mode: no per-branch namespaces to manage, no
  `lobs gc` needed for cleanup.
- The tradeoff is no isolation — a push from any branch updates the shared copy for
  everyone. This is the right choice when all branches should see the same data.
- Can be mixed with `branch` mode in the same repo: some targets use `fixed`, others use
  `branch` (configured per-pointer or per-directory).

### Scenario 5: Branch Lifecycle

A directory tracked with lobs (like Scenario 2 or 3) goes through a full branch
lifecycle: work on main, fork a feature branch, sync on the branch, collaborate, merge
back, and sync on main again.

This scenario shows how namespace isolation works across branches and what happens at
each transition.

**Starting state:** A directory `data/research-batch/` is already tracked on main (as in
Scenario 2). Both User 1 and User 2 have pulled the data.

```bash
$ lobs ns ls
  branches/main/           42 files   120.4 MB   updated 2026-02-18
```

**User 1 makes changes on main:**

```bash
# On main — update some files
$ cp updated-report.md data/research-batch/report.md
$ lobs status
  Namespace: branches/main/
  data/research-batch/      modified    (0 new, 1 changed, 0 deleted)

$ lobs push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  1 changed (0.4 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.lobs
$ git commit -m "Update research report"
$ git push
```

**User 1 creates a feature branch and syncs:**

```bash
$ git checkout -b feature/new-analysis
$ git push -u origin feature/new-analysis

# Check the namespace — it changed automatically
$ lobs ns show
Namespace mode: branch
Resolved: branches/feature/new-analysis/

# Status: no data in the new namespace yet
$ lobs status
  Namespace: branches/feature/new-analysis/
  data/research-batch/      local-only  (directory, 42 files)

# Push to create the new namespace with current data
$ lobs push
Pushing data/research-batch/ -> branches/feature/new-analysis/ (syncing directory)...
  42 files, 120.4 MB total (78.2 MB compressed)
  Manifest written.
Done. 1 target pushed.

$ git add data/research-batch.lobs
$ git commit -m "Initialize lobs data on feature branch"
$ git push
```

**User 1 makes changes on the feature branch:**

```bash
# Add new analysis results
$ cp analysis-v2.parquet data/research-batch/
$ rm data/research-batch/old-draft.md

$ lobs status
  Namespace: branches/feature/new-analysis/
  data/research-batch/      modified    (1 new, 0 changed, 1 deleted)

$ lobs push
Pushing data/research-batch/ -> branches/feature/new-analysis/ (syncing directory)...
  1 new, 0 changed, 1 deleted (12.5 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.lobs
$ git commit -m "Add v2 analysis, remove old draft"
$ git push

# Namespaces are now isolated — main is unchanged
$ lobs ns ls
  branches/main/                    42 files   120.4 MB   updated 2026-02-18
  branches/feature/new-analysis/    42 files   128.9 MB   updated 2026-02-19
```

**User 2 joins the feature branch:**

```bash
$ git fetch
$ git checkout feature/new-analysis

$ lobs status
  Namespace: branches/feature/new-analysis/
  data/research-batch/      stale       (local: main version, remote: feature version)

# Pull the feature branch's data
$ lobs pull
Pulling data/research-batch/ (syncing directory)...
  1 new, 0 changed, 1 deleted (12.5 MB transferred)
Done. 1 target pulled.

# Make additional changes
$ cp extra-data.json data/research-batch/

$ lobs push
Pushing data/research-batch/ -> branches/feature/new-analysis/ (syncing directory)...
  1 new (0.8 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.lobs
$ git commit -m "Add supplementary data"
$ git push
```

**Branch is merged via CI (GitHub PR):**

```bash
# PR is merged on GitHub — CI merges feature/new-analysis into main
# The merged pointer file now reflects the feature branch's latest state
# But the remote branches/main/ namespace still has the old data
```

**User 1 updates main after merge:**

```bash
$ git checkout main
$ git pull
# Pointer file updated with feature branch's latest hash

$ lobs ns show
Namespace mode: branch
Resolved: branches/main/

# Status: local data matches the pointer (User 1 still has the files from
# working on the feature branch), but remote branches/main/ is stale
$ lobs status
  Namespace: branches/main/
  data/research-batch/      modified    (local is newer than remote)

# Push to update the main namespace with the merged data
$ lobs push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  2 new, 0 changed, 1 deleted (13.3 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.lobs
$ git commit -m "Sync lobs data to main after merge"
$ git push
```

**User 2 syncs main:**

```bash
$ git checkout main
$ git pull

$ lobs status
  Namespace: branches/main/
  data/research-batch/      up-to-date

# User 2 already has the data from working on the feature branch,
# and User 1 has pushed it to branches/main/ — nothing to transfer
$ lobs pull
Already up-to-date. 0 targets pulled.
```

**Cleanup — remove the stale feature branch namespace:**

```bash
$ lobs ns ls
  branches/main/                    43 files   129.7 MB   updated 2026-02-19
  branches/feature/new-analysis/    43 files   129.7 MB   updated 2026-02-19

$ lobs gc --dry-run
Would remove: branches/feature/new-analysis/  (129.7 MB, no local branch)

$ lobs gc
Removed: branches/feature/new-analysis/ (129.7 MB)
Done. 1 namespace removed, 129.7 MB freed.
```

**Key points:**
- Switching branches changes the resolved namespace automatically.
  `lobs ns show` confirms which namespace is active.
- The first `lobs push` on a new branch creates a new namespace with a full copy of the
  data. Subsequent pushes are incremental.
- Namespaces are fully isolated: changes on `feature/new-analysis` don’t affect
  `branches/main/`.
- After a CI merge, a developer who has the local data must `lobs push` on main to
  update the `branches/main/` namespace.
  The pointer file from the merged branch is now on main, but the remote data is still
  under the old namespace until someone pushes.
- `lobs gc` cleans up branch namespaces that no longer have a corresponding local
  branch.

## Sync Semantics

### Push (Local to Remote)

**Single files:**
1. Hash local file.
2. Compare against hash recorded in `.lobs` pointer.
3. If different: compress (if enabled), upload to remote namespace, update `.lobs`
   pointer.
4. User commits updated `.lobs` files to git.

**Directories (with manifest, default):**
1. Scan local directory (applying ignore patterns from config, if any).
2. Fetch remote manifest from namespace.
3. `stat()` each local file and compare against the local stat cache.
   Files where `size` + `mtime_ms` match the cache: use cached `sha256` (no read).
   Files where stat differs or no cache entry: read and hash (SHA-256), update cache.
4. Compare local hashes and sizes against manifest: identify new, changed, and deleted
   files. Files where the hash matches the manifest are skipped (no re-upload).
5. Upload changed/new files (compressing if enabled), remove deleted files from remote.
6. Rewrite remote manifest with updated per-file hashes and sizes.
   Manifest is written as a single object PUT (atomic on S3-compatible stores).
7. Update `updated` timestamp in `.lobs` pointer only after manifest write succeeds.

**Idempotency and partial failure:** If push is interrupted, the remote manifest still
reflects the last complete push. Re-running push is safe: already-uploaded files are
detected via hash comparison and skipped. If the remote already has the expected object
(hash matches), upload is skipped even if the pointer was updated — this supports
merge/promotion workflows where data exists in one namespace but needs to appear in
another.

**Directories (without manifest):**
1. Delegate to transport tool (`aws s3 sync`, `rclone sync`) targeting the namespace
   prefix.
2. Transport tool handles change detection and incremental transfer.
3. Update `updated` timestamp in `.lobs` pointer.

### Pull (Remote to Local)

**Single files:**
1. Check if local file exists and matches pointer hash.
2. If missing or different from pointer: download from remote namespace, decompress (if
   needed).
3. If the local file has been modified (hash differs from both pointer and remote), pull
   fails with exit code 2. Use `--force` to overwrite local modifications.

**Directories (with manifest, default):**
1. Fetch remote manifest from namespace.
2. Compare local files against manifest using size and hash (applying ignore patterns
   from config, if any).
   Files where the hash matches are skipped.
3. Download missing or changed files (only non-ignored files).
   Decompress if needed.
4. Pull does not delete local files that are absent from the manifest.
   Extra local files are left untouched.

**Directories (without manifest):**
1. Delegate to transport tool (reverse direction).
2. Transport tool handles change detection.

### Conflict Detection

**Single-writer model (V1):** lobs assumes one writer per namespace at a time.
This is the common case for branch-based workflows where each developer works on their
own branch.

**Single files** use the pointer as common ancestor:
- Pointer hash = `X` (last synced state)
- Local hash = `Y`
- Remote hash = `Z`
- If `Y != X` and `Z != X`: conflict.

**Directories (with manifest):** If the remote manifest has changed since the last pull
(detected via ETag or timestamp), the push fails with exit code 2. The user must pull
first to reconcile.

**Directories (without manifest):** Delegated to transport tool.
`aws s3 sync` and `rclone` use size + mtime for change detection; conflicts are unlikely
in single-writer workflows.

### Bidirectional Sync (Deferred from V1)

`lobs sync` (bidirectional: pull then push) is deferred from V1 scope.
The interaction between pull-delete and push-delete semantics is underspecified and
potentially dangerous.
`push` and `pull` cover the common workflows; bidirectional sync will be revisited once
delete semantics and conflict handling are fully resolved.

For reference, the intended design is: `lobs sync` = pull then push, with configurable
conflict resolution (`--strategy error|local-wins|remote-wins`).

## Versioning and Branch Lifecycle

### How Versioning Works

`lobs` does not implement its own version history.
Git provides it. Namespaces provide branch isolation.

When you `lobs push`, the pointer file’s hash and timestamp update.
You commit those changes to git.
`git log data/prices.parquet.lobs` shows the version history.

To restore an old version of data within the current namespace:

```bash
git checkout HEAD~5 -- data/prices.parquet.lobs
lobs pull data/prices.parquet
```

This works because the current namespace still contains the data (namespaces are not
garbage collected automatically), and `lobs` never deletes remote objects during normal
sync operations.

### Branch Merge and Cleanup

When a feature branch is merged and deleted locally, its remote namespace
(`branches/feature-x/`) remains.
This is by design — remote data is never deleted implicitly.

Use `lobs gc` to clean up stale namespaces:

```bash
# Preview what would be removed
$ lobs gc --dry-run
Would remove: branches/feature-x/  (20.2 MB, no local branch, last updated 14d ago)
Would remove: branches/old-exp/    (5.1 MB, no local branch, last updated 45d ago)
Skipping:     branches/main/       (local branch exists)
Skipping:     fixed/               (not a branch namespace)

# Remove namespaces older than 30 days with no local branch
$ lobs gc --older-than 30d
Removed: branches/old-exp/ (5.1 MB)
Skipping: branches/feature-x/ (last updated 14d ago, newer than 30d)
Done. 1 namespace removed, 5.1 MB freed.

# Force remove all stale namespaces
$ lobs gc --force
Removed: branches/feature-x/ (20.2 MB)
Removed: branches/old-exp/ (5.1 MB)
Done. 2 namespaces removed, 25.3 MB freed.
```

`gc` never touches `fixed/` or `versions/` namespaces.
It removes `branches/` namespaces that have no corresponding local or remote-tracking Git
branch.
It also removes `detached/` namespaces older than a configurable TTL (default: 7 days),
since CI and ephemeral checkouts can create many of these.

## Agent and Automation Integration

### Machine-Readable Output

All commands support `--json`.
JSON output includes a `schema_version` field (e.g., `"schema_version": "0.1"`) so
automation can detect breaking changes:

```bash
$ lobs status --json
{
  "schema_version": "0.1",
  "namespace": "branches/main/",
  "namespace_mode": "branch",
  "tracked": 12,
  "modified": 2,
  "missing_local": 1,
  "files": [
    {
      "path": "data/prices.parquet",
      "status": "modified",
      "local_sha256": "abc...",
      "pointer_sha256": "def...",
      "size": 15728640,
      "namespace_mode": "branch"
    }
  ]
}
```

```bash
$ lobs ns ls --json
{
  "namespaces": [
    {
      "prefix": "branches/main/",
      "mode": "branch",
      "targets": 3,
      "total_size": 120400000,
      "updated": "2026-02-18T12:00:00Z",
      "has_local_branch": true
    },
    {
      "prefix": "fixed/",
      "mode": "fixed",
      "targets": 1,
      "total_size": 45000000,
      "updated": "2026-02-18T12:00:00Z"
    }
  ]
}
```

### Self-Documenting Pointer Files

Every `.lobs` file starts with:

```
# This is a large object reference file.
# Run npx lobs@latest --help for more on using lobs.
```

An agent encountering a `.lobs` file for the first time can read this header, run the
help command, and understand the system without external documentation.

### Idempotency

All commands are safe to run repeatedly:
- `lobs pull` when already up-to-date: no-op.
- `lobs push` when remote matches: no-op.
- `lobs track` on already-tracked path: updates pointer, no error.

### Non-Interactive by Default

All sync operations (`push`, `pull`, `status`, `diff`, `verify`, `gc`) are fully
non-interactive. They succeed or fail without prompts.
`--force` for destructive operations.
`--dry-run` for preview.
This makes `lobs` safe to call from scripts, CI pipelines, and agent tool loops.

`lobs init` is interactive when run without flags (prompts for backend type, bucket,
region). For non-interactive usage, pass flags directly:
`lobs init --bucket my-data --region us-east-1`.
All other commands are always non-interactive.

## Implementation Notes

### Language and Distribution

TypeScript. Distributed via npm as `lobs`. Usable via:
- `npx lobs@latest <command>` (no install)
- `npm install -g lobs` (global install)
- `pnpm add -D lobs` (project dev dependency)

### Key Dependencies

| Dependency | Purpose |
| --- | --- |
| `commander` | CLI parsing |
| `yaml` | Pointer and config file parsing |
| `@aws-sdk/client-s3` | Built-in S3 transfer fallback |
| `fast-glob` | File discovery for directory tracking |

### No Daemon

Pure CLI. Each invocation reads pointer files and config from disk, does work, updates
pointer files, exits.
No background processes, no lock files.
The only persistent local state is the stat cache (`.lobs/cache/`), which is a pure
optimization — if missing, all operations still work correctly, just slower.

### Testing

The `local` backend makes testing trivial.
Integration tests use a temp directory as the “remote.”
No cloud account needed for development.

## Scope Boundaries (V1)

What `lobs` does:
- Track files and directories via `.lobs` pointer files
- Namespace-based branch isolation (`branch`, `fixed`, `version` modes)
- Push/pull sync with pluggable backends
- Remote manifests for directory sync coordination
- Optional per-file compression with pluggable algorithms
- SHA-256 integrity verification (pointer hashes for files, manifest hashes for
  directories)
- Namespace garbage collection
- Hierarchical configuration with per-pointer overrides
- Gitignore management
- Machine-readable output for agents

What `lobs` does not do (V1):
- Bidirectional sync (deferred until delete semantics are resolved; use `push`/`pull`)
- Sub-file delta sync (whole-file granularity only)
- Cross-repo deduplication
- Cross-namespace deduplication (branch A and B store separate copies)
- Access control (relies on backend IAM)
- Lazy materialization (pull downloads everything)
- Content-addressable storage (path-mirrored only)
- Multi-writer merge logic
- Signed manifests or end-to-end cryptographic verification chains
- Web UI

These are candidates for future versions if demand warrants.

## Open Considerations and Critique

Items below are drawn from
[round 3 external review](lobs-design-review-round3-gpt5pro.md) (and earlier rounds)
where the right answer is not yet clear or involves a significant strategic trade-off.
They are recorded here so the discussion is not lost, and to inform future design
decisions.

### 1. V1 Product Promise: "Latest Mirror" vs "Immutable Snapshots"

The round 3 review identifies a tension at the heart of the design:

- **Promise A (simple):** "LOBS is a branch-isolated sync layer. Remote holds the latest
  state per namespace. Use `version` mode or bucket versioning for history." This matches
  the current path-mirrored remote layout.
- **Promise B (stronger):** "LOBS makes commits reproducible: pointers reference immutable
  remote content." This requires CAS-like storage or snapshot identifiers.

The current design uses Promise A mechanics but occasionally uses Promise B language
(e.g., restoring old versions by checking out old pointers). The design spec needs to
pick one and be consistent. The versioning semantics bead (`lobs-cx82`) addresses the
immediate contradictions, but the broader strategic question of whether lobs should ever
move toward Promise B (and what that would look like) remains open.

### 2. Content-Addressable Storage (CAS) as a Future Direction

The round 3 review suggests that if lobs wants "git checkout old commit -> get the right
data" to work reliably, it needs immutable object keys (e.g.,
`objects/<sha256>/<hash>`). This is a fundamental architecture decision:

- CAS enables time-travel, dedup, and reproducibility.
- CAS breaks remote browsability (the current design's explicit strength).
- A hybrid is possible: path-mirrored within a snapshot, with immutable snapshot IDs at
  the top level.

This is explicitly out of V1 scope but worth tracking as a design axis for V2.

### 3. Compression Suffix Convention

Three options were raised across reviews:

1. Accept `.zst` ambiguity and rely on manifest/pointer metadata to distinguish
   lobs-compressed from natively `.zst` files (simplest, current implicit approach).
2. Use `.lobs.zst` suffix for lobs-compressed files (clearer remotely, but longer names).
3. Store compression state only in manifest metadata, not in filename at all.

The round 3 review leans toward option 1 as adequate. The decision should be made
explicitly and documented.

### 4. Small-File Compression Threshold

The round 3 review suggests a default threshold (e.g., skip compressing files < 4 KB)
since compression overhead on tiny files can be counterproductive. This is a
quality-of-life optimization, not a correctness issue. Worth considering but not blocking.

### 5. Dictionary Compression (V2)

Round 1 notes that zstd dictionary training provides 2-5x improvement for small files
(< 64 KB) sharing structure (common with JSON/YAML datasets). The compression interface
should be designed to support this later (e.g., a `dictionary` field in config). Deferred.

### 6. Export/Import Specification

The `lobs export` / `lobs import` commands are mentioned but underspecified:

- Does the archive include pointer files?
- Does `import` create pointer files and gitignore entries?
- Flat dump or preserved directory structure?
- Seekable zstd for large archives?

These need specification before implementation but are not blocking other work.

### 7. Integration Surface: Library vs CLI Only

Round 1 asks whether lobs is intended to be used as a library by other tools, as a
subprocess, or purely as a standalone CLI. The design should state this explicitly. The
current design implies CLI-only, but the npm package could also expose a programmatic API.

### 8. Mixed Directories: Ignore Patterns vs Include Patterns

The round 3 review notes that the current model (ignore patterns to exclude small files
from lobs management) means `.gitignore` must be manually adjusted for mixed directories.
An alternative is flipping to an "include patterns" model where lobs tracks only matching
files and generates ignore entries for them. This changes the mental model but may be less
error-prone. The current approach works but is a known sharp edge.

### 9. Per-Pointer Namespace Override Complexity

Per-pointer namespace overrides are powerful but complicate output grouping, partial
failure handling, and concurrency. The round 3 review agrees with the round 1
recommendation to group operations by resolved namespace and treat each group
independently. The question is whether this complexity is justified for V1 or whether it
should be deferred to keep the initial implementation simpler.

### 10. `lobs sync` Bidirectional Semantics

All three reviews flag `lobs sync` (bidirectional: pull then push) as underspecified and
potentially dangerous, especially around deletion semantics. The round 3 review
recommends deferring it from V1 entirely. If kept, the interaction between pull-delete and
push-delete needs careful specification. A bead (`lobs-br1a`) tracks this.

### 11. s5cmd and Future Transport Engines

The round 3 review mentions s5cmd as a high-performance batching tool worth considering,
especially if lobs moves to manifest-driven file-by-file orchestration. Not blocking but
worth tracking as the transfer architecture solidifies.

### 12. `command` Backend as Integration Point

Round 1 notes the `command` backend could serve as a deliberate integration point for
domain-specific tools, not just an "escape hatch." This reframing has implications for how
well-specified the template variables and execution model need to be. The security
restrictions (bead `lobs-vj6p`) must be resolved first.
