# blobsy: Large Object Storage for Git Repos

**Status:** Draft

**Date:** 2026-02-18

A standalone CLI for namespace-based sync of large files and directories between local
gitignored paths and remote storage, with committed pointer files for tracking.

## Goals and Principles

1. **Simple:** Simple usage is easy.
   `blobsy track`, `blobsy push`, `blobsy pull`. No configuration required for the
   common case beyond a backend URL.

2. **CLI only:** No daemon, no server, no GUI. Pure stateless CLI that reads pointer
   files, does work, exits.

3. **Self-documenting:** Humans and agents learn to use it by running it.
   Every `.blobsy` file has a header comment explaining what it is and how to get help.
   Rich `--help` on every command.
   `--json` output for agents.
   Works well as a skill in agent toolchains.

4. **Customizable with sensible defaults:** Hierarchical config at file, directory,
   repo, and home folder levels.
   Zero config needed for common cases; full control available when needed.

5. **Flexible:** Works with any file types, any directory structures.
   No renaming of files or directories.
   Just gitignore the target and put a `.blobsy` file next to it.
   With or without checksumming.

6. **Infrastructure neutral:** Pluggable backend (S3, R2, local, custom command),
   pluggable sync engine (aws-cli, rclone, built-in), template-based namespace prefixes.
   Compression is a V2 feature (see Future Extensions).

7. **Transparent storage format:** Remote storage mirrors local directory structure,
   organized under namespaces.
   Files stored as-is with their original names.
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
backends, namespace-based branch isolation, push/pull sync, transparent remote storage
layout, and a simple standalone CLI. `blobsy` fills this gap as a namespace-based sync
coordinator that delegates heavy lifting to existing tools.

## Core Concepts

### The `.blobsy` Convention

For every tracked file or directory, a `.blobsy` pointer file sits adjacent to it with
the same name plus `.blobsy` appended:

```
data/prices.parquet           <- actual data (gitignored)
data/prices.parquet.blobsy      <- pointer file (committed to git)

data/research-batch/          <- actual directory (gitignored)
data/research-batch.blobsy      <- pointer file (committed to git)
```

The `.blobsy` file is committed to git.
The actual data is gitignored.
`blobsy` manages `.gitignore` entries automatically.

### Namespace Prefix

The core versioning problem: gitignored files don’t travel with branch checkouts.
If you push data on `feature-x`, switch to `main`, and push different data, you
overwrite the remote copy.
Namespace prefixes solve this by organizing remote storage into isolated segments.

The `namespace.prefix` config determines the remote path prefix under which data is
stored. It is a template string that can contain variables (in `{curly_braces}`) which
are resolved at runtime:

| Prefix | Resolves to | Use case |
| --- | --- | --- |
| `branches/{branch}` (default) | `branches/main/`, `branches/feature-x/` | Branch-isolated data. Each branch has its own copy. |
| `shared` | `shared/` | One shared prefix. All branches read/write the same data. |
| `versions/v2.1` | `versions/v2.1/` | Explicit versioning. Pin data to a release or experiment. |
| `team-a/{branch}` | `team-a/branches/main/` | Custom prefix with branch isolation. |

**V1 variables:**

| Variable | Resolves to | Notes |
| --- | --- | --- |
| `{branch}` | Current git branch name | Detached HEAD falls back to `detached/<sha>` using the first 12 characters of the commit SHA. |

Any string without `{variables}` is treated as a literal prefix.
This means `shared`, `global`, `production`, `versions/v2.1` all work as-is — no special
mode needed.

**CLI shorthands:** Common prefixes have convenient `--prefix` shortcuts:

```bash
blobsy track data/model.bin                            # uses default: branches/{branch}
blobsy track data/model.bin --prefix shared            # literal shared prefix
blobsy track data/model.bin --prefix "versions/v2.1"   # literal version prefix
blobsy track data/model.bin --prefix "teams/ml/{branch}"  # custom with branch variable
```

**Namespace prefix is set in config and can be overridden per-pointer.** The resolved
prefix (the actual path used) is computed at runtime, not stored in the pointer file.
This keeps pointer files stable across branches — the same `.blobsy` file resolves to
different remote paths depending on the current branch.

**Branch isolation (default, `branches/{branch}`):**
- Resolves the current Git branch name at runtime.
- Detached HEAD falls back to `detached/<sha>/` using the first 12 characters of the
  commit SHA (balances collision resistance with readability).
- Each branch gets isolated remote storage.
- Switching branches and running `blobsy pull` materializes that branch’s data.

**Shared prefix (e.g., `shared`):**
- Any literal string (no `{variables}`).
- Ignores the Git branch entirely.
- All branches share one remote copy.
- Appropriate for reference data, shared models, or simple single-branch workflows.

**Explicit version (e.g., `versions/v2.1`):**
- Just a literal prefix with a version in the path.
- For pinning data to a release, experiment run, or other explicit identifier.

#### Remote Storage Layout

With `branches/{branch}` prefix (default):

```
s3://bucket/prefix/
  branches/main/
    data/prices.parquet
    data/research-batch/
      .blobsy-manifest.json
      report.md
      raw/response.json
  branches/feature-x/
    data/prices.parquet
    data/research-batch/
      ...
```

With `shared` prefix:

```
s3://bucket/prefix/
  shared/
    data/prices.parquet
    data/research-batch/
      ...
```

With `versions/v2.1` prefix:

```
s3://bucket/prefix/
  versions/v2.1/
    data/prices.parquet
    ...
```

Browsable with `aws s3 ls`, web consoles, or any S3 tool.
No opaque hash-based storage.
Files are stored as-is with their original names (compression is a V2 feature).

### Pointer File Format

Every `.blobsy` file starts with a self-documenting comment header, followed by YAML.
Pointer files use stable key ordering (keys are always written in the order shown below)
to minimize noise in `git diff`.

**Field types and encoding:**
- `sha256`: 64-character lowercase hexadecimal string.
- `size`, `total_size`, `file_count`: integer, in bytes (for sizes).
- `updated`: ISO 8601 UTC timestamp with `Z` suffix (e.g., `2026-02-18T12:00:00Z`).

**Format versioning:** The `format` field uses `<name>/<major>.<minor>` versioning
(e.g., `blobsy/0.1`). Compatibility policy: reject if major version is unsupported; warn
if minor version is newer than the running blobsy version supports.
The same policy applies to `blobsy-manifest/<major>.<minor>` in manifest files.

**Single file pointer:**

```yaml
# This is a large object reference file.
# Run npx blobsy@latest --help for more on using blobsy.

format: blobsy/0.1
type: file
sha256: 7a3f0e...
size: 15728640
updated: 2026-02-18T12:00:00Z
```

**Directory pointer:**

```yaml
# This is a large object reference file.
# Run npx blobsy@latest --help for more on using blobsy.

format: blobsy/0.1
type: directory
manifest: true
updated: 2026-02-18T12:00:00Z
```

**Pointer with per-file overrides:**

```yaml
# This is a large object reference file.
# Run npx blobsy@latest --help for more on using blobsy.

format: blobsy/0.1
type: file
sha256: abc123...
size: 4294967296
prefix: shared                 # Override: share this file across all branches
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
Blobsy does not re-implement transfer verification.

**Change detection and at-rest verification** are handled by blobsy via SHA-256 hashes:

**Single files:** The pointer always includes `sha256` and `size`. One hash for one file
is cheap and enables:
- Local integrity verification without network access (`blobsy verify`)
- Change detection independent of mtime (which git checkout doesn’t preserve)
- Clear signal in `git diff` when data actually changed vs.
  just a timestamp update

**Directories (with manifest):** Per-file SHA-256 hashes stored in the remote manifest.
Enables accurate change detection during push and pull, and `blobsy verify` for
directories.

When using the built-in `@aws-sdk` transfer engine, hashes are computed during the
upload read (single I/O pass).
When delegating to external tools (aws-cli, rclone), hashing requires a separate read
pass — the file is read once to hash, then the external tool reads it again to transfer.
In practice the OS page cache makes the second read nearly free, and the stat cache
(below) ensures only changed files are hashed at all.

Hashing during push is critical for the core branch-switching workflow: `git checkout`
resets mtime on every file, so without content hashes, `blobsy push` after a branch
switch would re-upload everything.
With manifest hashes, push correctly identifies unchanged files and skips them.

**Directories (without manifest):** Change detection delegated entirely to the transport
tool. `blobsy verify` is not available.

Configurable via `checksum.algorithm`: `sha256` (default), `none` (skip hashing, rely
entirely on transport tool’s own change detection).

When checksum is `none`, blobsy trusts the sync tool entirely.
The `.blobsy` file becomes just a marker that says “this path is externally synced.”
Manifest files will store `size` only, and change detection falls back to size
comparison.

For independent verification outside of blobsy, SHA-256 is available everywhere:
- macOS: `shasum -a 256 <file>`
- Linux: `sha256sum <file>`
- Windows: `Get-FileHash <file> -Algorithm SHA256`

#### Why SHA-256 Over Provider-Native Hashes

Cloud storage providers each compute their own checksums, but the landscape is too
fragmented to rely on (see
[backing store research](../research/current/research-2026-02-19-backing-store-features.md),
Part 5). AWS S3 auto-computes CRC64NVME, GCS uses CRC32C, Azure uses MD5 (only for small
uploads — large block uploads may have no server-side hash at all), Backblaze uses
SHA-1, and R2/Wasabi/Tigris use MD5 ETags for non-multipart uploads only.
Multipart uploads (standard for large files) produce composite checksums on most
providers that don’t match a simple hash of the whole file — CRC64NVME on S3 is the
notable exception.

Computing SHA-256 independently and storing it in pointer files and manifests is the
only portable approach that works consistently across all providers.
It sidesteps all provider-specific hash fragmentation and gives blobsy a single,
well-understood verification mechanism regardless of backend.

The transport layer already handles transfer integrity (S3 verifies uploads via ETags,
`aws s3 sync` and `rclone` verify transfers internally), so blobsy does not need to
compute a provider-compatible hash for upload verification.
When using the built-in SDK, blobsy can provide `x-amz-checksum-sha256` with the upload
and S3 verifies server-side — but this uses the same SHA-256 blobsy already computes,
not an additional algorithm.

#### Future: Remote Staleness Detection via Provider Hashes

One optimization for a future version: after a successful push, blobsy could store the
provider’s response hash (e.g., ETag, `x-amz-checksum-crc64nvme`) in the manifest as an
opaque key-value pair — recording both the hash type and value (e.g.,
`{"provider_hash_algorithm": "etag", "provider_hash": "\"d41d8cd9...\""}`). This enables
cheap remote staleness detection: a `HeadObject` request returns the current provider
hash, and if it matches the stored value, the remote file hasn’t changed since last push
— without downloading or re-hashing.

Storing the hash type alongside the value is important: if a user changes backends
(e.g., migrates from S3 to R2), the stored provider hash becomes invalid.
By recording the algorithm/type, blobsy can detect the mismatch and fall back to a full
comparison rather than silently producing wrong results.

This is not needed for V1 — manifests and SHA-256 hashes handle all verification needs.
But it would make `blobsy status` faster for large deployments where even fetching the
manifest is expensive compared to a single HEAD request per file.

### Local Stat Cache

Blobsy maintains a local stat cache at `.blobsy/cache/stat-cache.json` (gitignored) that
stores the last-known `size`, `mtime_ms`, and `sha256` for each tracked file.
This follows the same approach as git’s index: use filesystem metadata as a fast-path to
avoid re-hashing unchanged files.

**How it works:**
1. On push or verify, blobsy calls `stat()` on each local file.
2. If `size` and `mtime_ms` match the cached entry, the cached `sha256` is trusted (file
   assumed unchanged — no read or hash needed).
3. If either differs, blobsy reads and hashes the file, then updates the cache.

**Why mtime is safe here but not in the manifest:** The stat cache is local and
per-machine. It only compares a file’s current mtime against the mtime recorded *on the
same machine* after the last hash.
This is a “definitely changed” signal — if mtime changed, something touched the file.
The remote manifest cannot use mtime because different machines, git checkouts, CI
runners, and Docker builds all produce different mtimes for the same content.

**High-resolution timestamps:** Node.js `fs.stat()` provides `mtimeMs` (millisecond
float) on all platforms.
Millisecond resolution is sufficient for blobsy — sub-millisecond file modifications
between cache writes are unlikely in practice.
(Git uses nanosecond timestamps with a “racily clean” detection fallback for the
pathological case; blobsy can add this if needed, but milliseconds are adequate for V1.)

**Performance impact:** `stat()` costs ~1-5 microseconds per file.
For a directory with 1,000 files, the stat pass takes ~~5 ms.
Without the cache, every push would read and hash all 1,000 files (~~seconds to minutes
depending on sizes).
With the cache, only files whose stat data changed are hashed.

| Scenario (1000 files, 10 MB avg) | Without stat cache | With stat cache |
| --- | --- | --- |
| First push | Hash all: ~20s | Hash all: ~20s (same) |
| Second push, 3 files changed | Hash all: ~20s | Stat all + hash 3: ~65ms |
| After `git checkout` (mtime reset on all) | Hash all: ~20s | Stat all + hash all: ~20s |

**Cache invalidation:** The cache is a pure optimization.
If missing or corrupted, blobsy falls back to hashing all files (correct but slower).
The cache is never shared across machines — it is gitignored and machine-local.

### Manifests

Manifests track the contents of directory targets.
They are stored remotely at a convention path alongside the data, not in the committed
pointer file.

**Location:** `<namespace>/<repo-path>/.blobsy-manifest.json` (e.g.,
`branches/main/data/research-batch/.blobsy-manifest.json`)

**Format (JSON):**

Manifests use canonical serialization: keys in fixed order, file entries sorted by
`path` (lexicographic, forward-slash separated), consistent newlines (LF), no trailing
whitespace. This ensures the same logical manifest always produces the same bytes, which
is required for stable `manifest_sha256` computation.

```json
{
  "format": "blobsy-manifest/0.1",
  "updated": "2026-02-18T12:00:00Z",
  "files": [
    {
      "path": "raw/response.json",
      "size": 1048576,
      "sha256": "b4c8d2..."
    },
    {
      "path": "report.md",
      "size": 4096,
      "sha256": "7a3f0e..."
    }
  ],
  "total_size": 1052672
}
```

**Sync role:** On `push`, blobsy rewrites the remote manifest after uploading files.
On `pull`, blobsy fetches the manifest first, then materializes local files.
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

When `blobsy track` is run, the CLI adds the target path to the `.gitignore` file in the
same directory as the tracked path (following the DVC convention).
This keeps gitignore entries co-located with the things they ignore.
If no `.gitignore` exists in that directory, one is created.

Entries are placed in a clearly marked section:

```gitignore
# >>> blobsy-managed (do not edit) >>>
data/prices.parquet
data/research-batch/
# <<< blobsy-managed <<<
```

`blobsy untrack` removes the entry.
The section markers prevent accidental edits and make it easy for the CLI to manage
entries idempotently.

## Configuration

### Hierarchy

Four levels, each overriding the one above:

```
~/.config/blobsy/config.yml          Global defaults
<repo>/.blobsy/config.yml            Repo-level
<repo>/subdir/.blobsy/config.yml     Directory-level override
<repo>/subdir/file.parquet.blobsy    Per-file (inline overrides)
```

Resolution is bottom-up: per-file settings win over directory, directory over repo, repo
over global.

### Repo-Level Config (Minimum Viable)

```yaml
# .blobsy/config.yml
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
# .blobsy/config.yml
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
    path: /tmp/blobsy-test-remote/

  custom:
    type: command
    push: "my-upload {local} {remote}"
    pull: "my-download {remote} {local}"

namespace:
  prefix: "branches/{branch}"  # Template string. Default: "branches/{branch}"
                               # Literal examples: "shared", "versions/v2.1"
                               # Variables: {branch} (V1)

# compression: (V2 feature — not available in V1)
#   algorithm: zstd            # zstd | gzip | lz4 | none | command
#   level: 3

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

When tracking a directory, blobsy syncs all files within it by default.
Ignore patterns let you exclude specific files or subdirectories from blobsy management,
so they remain local-only or in git.

Ignore patterns use gitignore syntax, evaluated relative to the tracked directory root.
They participate in the standard config hierarchy:

```
~/.config/blobsy/config.yml          Global ignore defaults (e.g., __pycache__/, .DS_Store)
<repo>/.blobsy/config.yml            Repo-level ignores
<repo>/data/analysis/.blobsy/config.yml   Directory-level ignores (specific to this target)
```

Resolution is bottom-up, same as all other config.
Directory-level ignores override repo-level ignores.

Ignore patterns only apply to directory targets.
They have no effect on single-file pointers (a single tracked file is either tracked or
not).

**Example:** A `data/analysis/` directory contains `.parquet` files (large, should be in
blobsy) and `.py` scripts and `.md` files (small, should be in git):

```yaml
# data/analysis/.blobsy/config.yml
ignore:
  - "*.py"
  - "*.md"
  - "*.txt"
  - "scripts/"
```

With this config, `blobsy push data/analysis/` syncs only the non-ignored files (the
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
tracked directory contains a mix of blobsy-managed and git-managed files.
The user is responsible for managing `.gitignore` entries for the blobsy-managed files
within the directory (e.g., adding `data/analysis/*.parquet` to `.gitignore`).
`blobsy track` adds the directory to `.gitignore` by default; when ignore patterns are
present, blobsy warns that the user should adjust `.gitignore` to exclude only the
blobsy-managed files, not the entire directory.

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
- `{remote}` — full remote key (e.g., `branches/main/data/prices.parquet`).
- `{relative_path}` — repo-relative path of the tracked target (e.g.,
  `data/prices.parquet`).
- `{namespace}` — resolved namespace prefix (e.g., `branches/main`). (Note: this is the
  resolved value of `namespace.prefix`, not the template.)
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
# R2 via AWS CLI (what blobsy does internally)
aws s3 sync ./local/ s3://bucket/prefix/branches/main/ \
  --endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com

# rclone also works natively with R2 and other S3-compatible stores
```

There is no separate R2 backend type.
Cloudflare’s own `wrangler r2` CLI exists but is less mature for bulk operations.
The AWS CLI + endpoint approach is standard practice.

### Transfer Delegation

`blobsy` does not implement high-performance transfers.
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

`blobsy` inherits symlink behavior from the underlying transport tool.
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

## Compression System (V2)

Compression is deferred from V1. Files are stored as-is with their original names.
This significantly simplifies V1: no staging directories, no suffix conventions, no
skip-list logic, no `stored_as` field in manifests.

Users who need smaller remote storage can compress files manually before tracking.
Compression will be introduced as the first V2 feature.
See Future Extensions (V2) for the planned design.

### Archive Export

Separate from sync. `blobsy export` produces a `tar.zst` archive of tracked files for
offline sharing, backup, or migration.
`blobsy import` restores from an archive.
Uses high compression (zstd level 19).

## CLI Design

### Commands

```
SETUP
  blobsy init                          Initialize blobsy in a git repo
                                     Creates .blobsy/config.yml, updates .gitignore
  blobsy config [key] [value]          Get/set configuration
  blobsy backend add <name>            Add a backend
  blobsy backend ls                    List configured backends

TRACKING
  blobsy track <path> [--backend B]    Start tracking a file or directory
       [--prefix <prefix>]           Override namespace prefix (e.g., "shared")
       [--no-manifest]               Creates .blobsy pointer, adds to .gitignore
  blobsy untrack <path>                Stop tracking, remove pointer and gitignore entry
  blobsy ls [--json]                   List all tracked paths with sync status

SYNC
  blobsy push [path...]                Upload local changes to remote
       [--prefix <prefix>]           Override namespace prefix for this push
  blobsy pull [path...]                Download from remote to local
       [--force]                     Overwrite local modifications
  blobsy status [path...]              Show what's changed locally vs remotely
  blobsy diff [path...]                Preview what push/pull would transfer

NAMESPACE MANAGEMENT
  blobsy ns ls                         List all remote prefixes with sizes
  blobsy ns show                       Show current resolved prefix
  blobsy gc [--dry-run]                Remove prefixes with no corresponding local branch
       [--older-than <duration>]     Only remove prefixes not updated in <duration>

UTILITIES
  blobsy verify [path...]              Verify local files match pointer hashes
  blobsy cache info                    Show storage statistics
  blobsy export [path...] -o FILE      Export tracked files as tar.zst archive
  blobsy import FILE                   Import from archive
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
$ blobsy init
Created .blobsy/config.yml
? Default backend type: s3
? Bucket: my-datasets
? Prefix: project-v1/
? Region: us-east-1
Namespace prefix: branches/{branch} (default)

# Track a large file
$ blobsy track data/prices.parquet
Created data/prices.parquet.blobsy
Added data/prices.parquet to .gitignore

# Track a directory (manifest enabled by default)
$ blobsy track data/research-batch/
Created data/research-batch.blobsy (manifest enabled)
Added data/research-batch/ to .gitignore

# Track shared reference data (shared prefix, no branch isolation)
$ blobsy track data/shared-models/ --prefix shared
Created data/shared-models.blobsy (prefix: shared, manifest enabled)
Added data/shared-models/ to .gitignore

# Check current prefix
$ blobsy ns show
Namespace prefix: branches/{branch}
Resolved: branches/main/

# Check status
$ blobsy status
  Prefix: branches/main/
  data/prices.parquet       local-only  15.0 MB
  data/research-batch/      local-only  (directory, manifest)
  data/shared-models/       local-only  (directory, manifest, prefix: shared)

# Push to remote
$ blobsy push
Pushing data/prices.parquet -> branches/main/ (15.0 MB)...
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
Pushing data/shared-models/ -> shared/ (syncing directory)...
Done. 3 targets pushed.

# Switch branches and pull
$ git checkout feature-x
$ blobsy pull
Prefix: branches/feature-x/
Pulling data/prices.parquet (not in prefix, skipping)...
Pulling data/research-batch/ (not in prefix, skipping)...
Pulling data/shared-models/ <- shared/ (already up-to-date)...
Done.

# Push data on the feature branch (creates new prefix)
$ blobsy push
Pushing data/prices.parquet -> branches/feature-x/ (15.0 MB)...
Pushing data/research-batch/ -> branches/feature-x/ (syncing directory)...
Pushing data/shared-models/ -> shared/ (already up-to-date)...
Done.

# List all namespaces
$ blobsy ns ls
  branches/main/           3 targets   120.4 MB   updated 2026-02-18
  branches/feature-x/      2 targets    20.2 MB   updated 2026-02-18
  shared/                  1 target     45.0 MB   updated 2026-02-18

# Another machine: pull
$ blobsy pull
Pulling data/prices.parquet (15.0 MB)...
Pulling data/research-batch/ (syncing directory)...
Done. 3 targets pulled.

# Incremental push after local changes
$ blobsy push data/research-batch/
Syncing data/research-batch/ -> branches/main/ ...
  3 files changed, 1 new, 0 deleted
Done.
```

## Usage Scenarios

The example session above shows single-user setup and sync.
These scenarios show multi-user collaboration — the primary use case for blobsy.

### Scenario 1: Single Large File

A team shares a large data file via blobsy.
One user sets it up, others pull and contribute changes.

**User 1 sets up tracking:**

```bash
# Initialize blobsy in the repo (one-time)
$ blobsy init
Created .blobsy/config.yml
? Bucket: team-datasets
? Prefix: my-project/
? Region: us-east-1

# Track a large file
$ blobsy track data/prices.parquet
Created data/prices.parquet.blobsy
Added data/prices.parquet to .gitignore

# Push the data to remote storage
$ blobsy push
Pushing data/prices.parquet -> branches/main/ (15.0 MB)...
Done. 1 target pushed.

# Commit the pointer file and config to git
$ git add .blobsy/config.yml data/prices.parquet.blobsy .gitignore
$ git commit -m "Track prices.parquet with blobsy"
$ git push
```

At this point, the git repo contains the pointer file and config.
The actual data lives in remote storage.

**User 2 joins and pulls the data:**

```bash
# Pull the latest git changes — sees the new .blobsy pointer
$ git pull
# New files: .blobsy/config.yml, data/prices.parquet.blobsy, .gitignore

# Check what blobsy tracks and what's out of sync
$ blobsy status
  Prefix: branches/main/
  data/prices.parquet       missing     (remote: 15.0 MB)

# Pull the data
$ blobsy pull
Pulling data/prices.parquet (15.0 MB)...
Done. 1 target pulled.

# The file is now materialized locally
$ ls -lh data/prices.parquet
-rw-r--r--  1 user2  staff  15M Feb 18 12:00 data/prices.parquet
```

**User 2 makes a change and pushes:**

```bash
# After modifying the file locally...
$ blobsy status
  Prefix: branches/main/
  data/prices.parquet       modified    15.0 MB -> 16.1 MB

# Push the updated file
$ blobsy push
Pushing data/prices.parquet -> branches/main/ (16.1 MB)...
Done. 1 target pushed.

# The pointer file was updated by push — commit it
$ git add data/prices.parquet.blobsy
$ git commit -m "Update prices data"
$ git push
```

**Users 1 and 3 see the change and sync:**

```bash
# Pull git changes — sees the updated pointer
$ git pull
# Updated: data/prices.parquet.blobsy (sha256 changed)

# Status shows local data is stale
$ blobsy status
  Prefix: branches/main/
  data/prices.parquet       stale       (local: 15.0 MB, remote: 16.1 MB)

# Pull when ready
$ blobsy pull
Pulling data/prices.parquet (16.1 MB)...
Done. 1 target pulled.
```

**Key points:**
- The `.blobsy` pointer in git is the coordination signal — `git diff` shows when data
  changed.
- `blobsy status` tells you whether your local data matches the pointer.
- Users only fetch large data when they choose to (`blobsy pull`), not automatically.
- The workflow is always: `blobsy push` then `git commit` the pointer, or `git pull`
  then `blobsy pull` the data.

### Scenario 2: Directory of Files

Same multi-user collaboration, but with a directory containing many files.

**User 1 sets up tracking:**

```bash
# Track a directory (manifest enabled by default)
$ blobsy track data/research-batch/
Created data/research-batch.blobsy (manifest enabled)
Added data/research-batch/ to .gitignore

# Push all files in the directory
$ blobsy push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  42 files, 120.4 MB total
  Manifest written.
Done. 1 target pushed.

# Commit pointer to git
$ git add data/research-batch.blobsy .gitignore
$ git commit -m "Track research-batch directory with blobsy"
$ git push
```

**User 2 pulls and makes changes:**

```bash
$ git pull
$ blobsy status
  Prefix: branches/main/
  data/research-batch/      missing     (remote: 42 files, 120.4 MB)

$ blobsy pull
Pulling data/research-batch/ (syncing directory)...
  42 files downloaded (120.4 MB)
Done. 1 target pulled.

# User 2 adds new files and modifies an existing one
$ cp new-data.json data/research-batch/
$ vim data/research-batch/report.md

$ blobsy status
  Prefix: branches/main/
  data/research-batch/      modified    (1 new, 1 changed, 0 deleted)

$ blobsy push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  1 new, 1 changed, 0 deleted (2.1 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.blobsy
$ git commit -m "Add new data and update report"
$ git push
```

**Key points (in addition to Scenario 1):**
- The remote manifest tracks directory contents, so incremental sync transfers only
  changed files.
- `blobsy status` shows a summary of new/changed/deleted files within the directory.
- The pointer file’s `updated` timestamp changes on push, signaling a new version in
  git.

### Scenario 3: Mixed Directory (Selective Tracking)

A directory containing both large files (synced via blobsy) and small files (committed
to git). Ignore patterns in the directory-level config control which files blobsy
manages.

**Example layout:**

```
data/analysis/
  model-weights.bin         120 MB  <- too large for git, blobsy-managed
  embeddings.parquet         45 MB  <- too large for git, blobsy-managed
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
$ blobsy track data/analysis/
Created data/analysis.blobsy (manifest enabled)
Added data/analysis/ to .gitignore

# Configure ignore patterns for the small, git-managed files
$ mkdir -p data/analysis/.blobsy
$ cat > data/analysis/.blobsy/config.yml << 'EOF'
ignore:
  - "*.py"
  - "*.yaml"
  - "*.md"
  - "scripts/"
EOF

# Adjust .gitignore: don't ignore the whole directory, only the large files
# (Remove the blanket directory entry that blobsy track created,
#  and add specific entries for blobsy-managed files)
$ vim .gitignore
# Result: .gitignore now has specific entries like:
#   data/analysis/model-weights.bin
#   data/analysis/embeddings.parquet
# instead of:
#   data/analysis/

# Push — only non-ignored files are synced
$ blobsy push
Pushing data/analysis/ -> branches/main/ (syncing directory)...
  2 files (model-weights.bin, embeddings.parquet), 165 MB
  Manifest written.
Done. 1 target pushed.

# Commit everything to git: pointer, config, ignored small files, gitignore
$ git add data/analysis/.blobsy/config.yml data/analysis.blobsy .gitignore
$ git add data/analysis/process.py data/analysis/config.yaml data/analysis/README.md
$ git add data/analysis/scripts/
$ git commit -m "Track analysis directory with blobsy (large files only)"
$ git push
```

**User 2 pulls:**

```bash
$ git pull
# Gets: pointer file, .blobsy config with ignore patterns, all the small files
# Does NOT get: model-weights.bin, embeddings.parquet (gitignored, blobsy-managed)

$ blobsy status
  Prefix: branches/main/
  data/analysis/            missing     (remote: 2 files, 165 MB)
                            ignored: *.py, *.yaml, *.md, scripts/

$ blobsy pull
Pulling data/analysis/ (syncing directory, 2 files matching)...
  model-weights.bin (120 MB), embeddings.parquet (45 MB)
Done. 1 target pulled.

# Now the directory is complete: large files from blobsy, small files from git
$ ls data/analysis/
config.yaml  embeddings.parquet  model-weights.bin  process.py  README.md  scripts/
```

**Key points (in addition to Scenarios 1 and 2):**
- Ignore patterns use gitignore syntax, configured in the directory-level
  `.blobsy/config.yml`.
- The config file is committed to git, so all team members share the same ignore
  patterns.
- `blobsy status` shows both the tracked files and the active ignore patterns.
- `.gitignore` must be adjusted manually for mixed directories: ignore the
  blobsy-managed files specifically, not the entire directory.
- Small files flow through git normally.
  Large files flow through blobsy.
  Both live in the same directory.

### Scenario 4: Shared Prefix (Shared Data)

Shared reference data — a model, a dataset, a set of fixtures — that every branch reads
and occasionally updates.
Uses a literal prefix (e.g., `shared`): one copy in remote storage, no branch isolation,
all users and branches see the same data.

**User 1 sets up tracking with shared prefix:**

```bash
# Track a shared model directory with shared prefix
$ blobsy track models/base-model/ --prefix shared
Created models/base-model.blobsy (prefix: shared, manifest enabled)
Added models/base-model/ to .gitignore

$ blobsy ns show
Namespace prefix: shared
Resolved: shared/

$ blobsy push
Pushing models/base-model/ -> shared/ (syncing directory)...
  5 files, 2.3 GB total
  Manifest written.
Done. 1 target pushed.

$ git add models/base-model.blobsy .gitignore
$ git commit -m "Track shared base model with blobsy (shared prefix)"
$ git push
```

**User 2 pulls on any branch — same data regardless of branch:**

```bash
$ git checkout feature/experiment-7
$ git pull origin main  # get the pointer file

$ blobsy ns show
Namespace prefix: shared
Resolved: shared/

# Shared prefix — same remote location regardless of branch
$ blobsy pull
Pulling models/base-model/ <- shared/ (syncing directory)...
  5 files, 2.3 GB
Done. 1 target pulled.
```

**CI pipeline pulls the same data:**

```bash
# CI is on main, but it doesn't matter — shared prefix ignores the branch
$ blobsy pull
Pulling models/base-model/ <- shared/ ...
Done. 1 target pulled.
```

**User 1 updates the shared model (from any branch):**

```bash
# On main, or feature/experiment-7, or any branch — doesn't matter
$ cp retrained-model.bin models/base-model/model.bin

$ blobsy status
  Prefix: shared/
  models/base-model/        modified    (0 new, 1 changed, 0 deleted)

$ blobsy push
Pushing models/base-model/ -> shared/ (syncing directory)...
  1 changed (800 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add models/base-model.blobsy
$ git commit -m "Update base model with retrained weights"
$ git push
```

**All users and CI see the update:**

```bash
# Any branch, any user, any environment
$ blobsy status
  Prefix: shared/
  models/base-model/        stale       (remote has newer version)

$ blobsy pull
Pulling models/base-model/ <- shared/ ...
  1 changed (800 MB transferred)
Done. 1 target pulled.
```

**Key points:**
- A literal prefix like `shared` means one remote location shared by all branches.
  Switching branches does not change the resolved prefix.
- Useful for reference data, shared models, common fixtures, or any data that shouldn’t
  diverge across branches.
- The workflow is simpler than `branches/{branch}`: no per-branch prefixes to manage, no
  `blobsy gc` needed for cleanup.
- The tradeoff is no isolation — a push from any branch updates the shared copy for
  everyone. This is the right choice when all branches should see the same data.
- Can be mixed in the same repo: some targets use `shared`, others use
  `branches/{branch}` (configured per-pointer or per-directory).

### Scenario 5: Branch Lifecycle

A directory tracked with blobsy (like Scenario 2 or 3) goes through a full branch
lifecycle: work on main, fork a feature branch, sync on the branch, collaborate, merge
back, and sync on main again.

This scenario shows how namespace isolation works across branches and what happens at
each transition.

**Starting state:** A directory `data/research-batch/` is already tracked on main (as in
Scenario 2). Both User 1 and User 2 have pulled the data.

```bash
$ blobsy ns ls
  branches/main/           42 files   120.4 MB   updated 2026-02-18
```

**User 1 makes changes on main:**

```bash
# On main — update some files
$ cp updated-report.md data/research-batch/report.md
$ blobsy status
  Prefix: branches/main/
  data/research-batch/      modified    (0 new, 1 changed, 0 deleted)

$ blobsy push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  1 changed (0.4 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.blobsy
$ git commit -m "Update research report"
$ git push
```

**User 1 creates a feature branch and syncs:**

```bash
$ git checkout -b feature/new-analysis
$ git push -u origin feature/new-analysis

# Check the prefix — it changed automatically
$ blobsy ns show
Namespace prefix: branches/{branch}
Resolved: branches/feature/new-analysis/

# Status: no data in the new prefix yet
$ blobsy status
  Prefix: branches/feature/new-analysis/
  data/research-batch/      local-only  (directory, 42 files)

# Push to create the new prefix with current data
$ blobsy push
Pushing data/research-batch/ -> branches/feature/new-analysis/ (syncing directory)...
  42 files, 120.4 MB total
  Manifest written.
Done. 1 target pushed.

$ git add data/research-batch.blobsy
$ git commit -m "Initialize blobsy data on feature branch"
$ git push
```

**User 1 makes changes on the feature branch:**

```bash
# Add new analysis results
$ cp analysis-v2.parquet data/research-batch/
$ rm data/research-batch/old-draft.md

$ blobsy status
  Prefix: branches/feature/new-analysis/
  data/research-batch/      modified    (1 new, 0 changed, 1 deleted)

$ blobsy push
Pushing data/research-batch/ -> branches/feature/new-analysis/ (syncing directory)...
  1 new, 0 changed, 1 deleted (12.5 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.blobsy
$ git commit -m "Add v2 analysis, remove old draft"
$ git push

# Namespaces are now isolated — main is unchanged
$ blobsy ns ls
  branches/main/                    42 files   120.4 MB   updated 2026-02-18
  branches/feature/new-analysis/    42 files   128.9 MB   updated 2026-02-19
```

**User 2 joins the feature branch:**

```bash
$ git fetch
$ git checkout feature/new-analysis

$ blobsy status
  Prefix: branches/feature/new-analysis/
  data/research-batch/      stale       (local: main version, remote: feature version)

# Pull the feature branch's data
$ blobsy pull
Pulling data/research-batch/ (syncing directory)...
  1 new, 0 changed, 1 deleted (12.5 MB transferred)
Done. 1 target pulled.

# Make additional changes
$ cp extra-data.json data/research-batch/

$ blobsy push
Pushing data/research-batch/ -> branches/feature/new-analysis/ (syncing directory)...
  1 new (0.8 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.blobsy
$ git commit -m "Add supplementary data"
$ git push
```

**Branch is merged via CI (GitHub PR):**

```bash
# PR is merged on GitHub — CI merges feature/new-analysis into main
# The merged pointer file now reflects the feature branch's latest state
# But the remote branches/main/ prefix still has the old data
```

**User 1 updates main after merge:**

```bash
$ git checkout main
$ git pull
# Pointer file updated with feature branch's latest hash

$ blobsy ns show
Namespace prefix: branches/{branch}
Resolved: branches/main/

# Status: local data matches the pointer (User 1 still has the files from
# working on the feature branch), but remote branches/main/ is stale
$ blobsy status
  Prefix: branches/main/
  data/research-batch/      modified    (local is newer than remote)

# Push to update the main prefix with the merged data
$ blobsy push
Pushing data/research-batch/ -> branches/main/ (syncing directory)...
  2 new, 0 changed, 1 deleted (13.3 MB transferred)
  Manifest updated.
Done. 1 target pushed.

$ git add data/research-batch.blobsy
$ git commit -m "Sync blobsy data to main after merge"
$ git push
```

**User 2 syncs main:**

```bash
$ git checkout main
$ git pull

$ blobsy status
  Prefix: branches/main/
  data/research-batch/      up-to-date

# User 2 already has the data from working on the feature branch,
# and User 1 has pushed it to branches/main/ — nothing to transfer
$ blobsy pull
Already up-to-date. 0 targets pulled.
```

**Cleanup — remove the stale feature branch prefix:**

```bash
$ blobsy ns ls
  branches/main/                    43 files   129.7 MB   updated 2026-02-19
  branches/feature/new-analysis/    43 files   129.7 MB   updated 2026-02-19

$ blobsy gc --dry-run
Would remove: branches/feature/new-analysis/  (129.7 MB, no local branch)

$ blobsy gc
Removed: branches/feature/new-analysis/ (129.7 MB)
Done. 1 prefix removed, 129.7 MB freed.
```

**Key points:**
- Switching branches changes the resolved prefix automatically.
  `blobsy ns show` confirms which prefix is active.
- The first `blobsy push` on a new branch creates a new prefix with a full copy of the
  data. Subsequent pushes are incremental.
- Prefixes are fully isolated: changes on `feature/new-analysis` don’t affect
  `branches/main/`.
- After a CI merge, a developer who has the local data must `blobsy push` on main to
  update the `branches/main/` prefix.
  The pointer file from the merged branch is now on main, but the remote data is still
  under the old prefix until someone pushes.
- `blobsy gc` cleans up branch prefixes that no longer have a corresponding local
  branch.

## Corner Cases and Pitfalls

The usage scenarios above show happy paths.
This section catalogs what goes wrong and how blobsy handles it (or how the user
recovers).

### Push/Commit Coordination

**Pushed data but forgot to commit the pointer.** User runs `blobsy push` (data uploads
to remote) but doesn’t `git add` and `git commit` the updated `.blobsy` pointer file.
Other users have no way to know the remote data changed.
The pointer in git still references the old hash.

Recovery: commit the pointer file.
Until then, other users see no change.

Detection: `blobsy status` on the pusher’s machine shows “up-to-date” (local matches
remote). The problem is invisible to the pusher — it only manifests when other users
don’t see the update.
This is the most common mistake.

**Committed the pointer but forgot to push data.** User updates a file, runs `git add`
and `git commit` on the `.blobsy` pointer (perhaps manually edited, or from a previous
`blobsy push` that was followed by more local changes before the data was re-pushed).
Other users pull from git, see the updated pointer, run `blobsy pull`, and the remote
data doesn’t match the pointer hash — or doesn’t exist at all in the resolved prefix.

Recovery: the original user runs `blobsy push` to upload the data that matches the
committed pointer.

Detection: `blobsy pull` fails or warns when the remote file’s hash doesn’t match the
pointer. `blobsy status` on the pulling user’s machine shows “missing” with a pointer
hash that can’t be resolved remotely.

**Pushed data, then switched branches without committing.** User runs `blobsy push` on
branch A, then `git checkout B` without committing the updated pointer.
The pointer update is lost (unstaged changes discarded by checkout, or left as
uncommitted modifications).
The data is in the remote prefix but nothing in git references it.

Recovery: switch back to branch A, the uncommitted pointer changes may still be in the
working tree. If lost, re-run `blobsy push` to regenerate the pointer.

### Post-Merge Prefix Gap

After a branch merge (especially via CI/GitHub PR), the merged pointer file is on main
but the `branches/main/` remote prefix still has pre-merge data.
This is because the pointer doesn’t store the prefix — it’s resolved at runtime from the
current branch.

The data exists in `branches/feature-x/` but a user on main resolves to
`branches/main/`.

Recovery: a developer who has the local data (from working on the feature branch) checks
out main and runs `blobsy push`. This uploads the data to `branches/main/`.

This is the expected workflow, not a bug — but it’s the most surprising behavior for new
users. Scenario 5 walks through this in detail.

Potential future improvement: `blobsy push --from-prefix <prefix>` to copy data between
prefixes without needing the local files.

### Concurrent Writers

**Two users pushing to the same branch prefix.** With manifests enabled (default), the
second push fails with exit code 2 if the manifest changed since the user’s last pull.
The user must `blobsy pull` first to get the latest state, then `blobsy push` again.

Without manifests, the transport tool (`aws s3 sync`, `rclone`) handles conflicts via
last-write-wins semantics.
Files may be partially overwritten if pushes overlap.

**Two users updating shared-prefix data simultaneously.** Same conflict detection
applies. With manifests, the second writer gets a conflict error.
Without manifests, last-write-wins.
Shared-prefix data that changes frequently should use manifests (the default) and
coordinate writes.

### Interrupted Transfers

**Push interrupted midway.** Some files uploaded, manifest not yet updated (manifest is
written atomically at the end).
Re-running `blobsy push` is safe: already-uploaded files are detected via hash
comparison and skipped.
Only remaining files are transferred.
The manifest is written after all uploads succeed.

**Pull interrupted midway.** Some files downloaded, others missing.
Re-running `blobsy pull` is safe: already-downloaded files that match the manifest hash
are skipped. Partially downloaded files (wrong size or hash) are re-downloaded.

### Branch and Prefix Edge Cases

**Detached HEAD.** When the prefix contains `{branch}` and HEAD is detached, it falls
back to `detached/<shortsha>/`. This works but creates prefixes that `blobsy gc` does
not clean up by default (gc only cleans `branches/` prefixes).
CI environments that check out specific commits (detached HEAD) can accumulate orphaned
prefixes.

Mitigation: CI should use `--prefix shared` or an explicit literal prefix for CI-built
data. For manual detached HEAD work, use `blobsy ns ls` to find and manually remove
orphaned `detached/` prefixes.

**`blobsy gc` deletes a colleague’s branch prefix.** `gc` checks local branches only.
If a colleague has a remote branch that you haven’t fetched, `gc` considers its prefix
stale and removes it.

Mitigation: run `git fetch --all` before `blobsy gc` to ensure all remote branches are
known locally. Or use `blobsy gc --dry-run` first to review what would be removed.
The round 1 review (S2) recommends checking remote tracking branches as well — this may
be addressed in implementation.

**First push on a new branch is a full copy.** When you create a feature branch and
`blobsy push`, blobsy uploads all files to the new `branches/feature-x/` prefix — even
though the data is identical to `branches/main/`. There is no cross-prefix deduplication
in V1. For large datasets, this can be slow and expensive.

Mitigation: this is a known V1 limitation (listed in Scope Boundaries).
For very large datasets where branch copies are impractical, consider a shared literal
prefix instead.

### Gitignore Misconfiguration

**Mixed directory: forgot to adjust `.gitignore`.** After adding ignore patterns to a
tracked directory, `blobsy track` initially adds the entire directory to `.gitignore`.
If the user doesn’t adjust this to exclude only the blobsy-managed files, the small
git-managed files are also gitignored — they won’t appear in `git status` and won’t be
committed.

Detection: `git status` doesn’t show the small files.
`ls` shows them locally but they’re invisible to git.

Recovery: edit `.gitignore` to replace the blanket directory entry with specific entries
for the blobsy-managed files only (as shown in Scenario 3).

**Mixed directory: accidentally committed large files to git.** The inverse problem:
`.gitignore` doesn’t cover the blobsy-managed files, so `git add .` stages them.
Large files end up in git history permanently.

Detection: `git status` shows large files as staged.
Commit sizes are unexpectedly large.

Prevention: always verify `.gitignore` after setting up a mixed directory.
`blobsy status` shows which files are blobsy-managed — cross-check against `.gitignore`.

### Git Workflow Interactions

**`git stash` doesn’t affect blobsy data.** Stashing saves the pointer file changes but
leaves the actual data (gitignored) untouched.
After `git stash pop`, the pointer is restored but the local data may have changed in
the meantime. Run `blobsy status` after unstashing to check consistency.

**`git revert` of a pointer update.** Reverting a commit that updated a pointer file
restores the old hash in the pointer.
The local data still has the newer content.
`blobsy status` shows “modified” (local doesn’t match pointer).
`blobsy pull` downloads the older version from remote (if it still exists in the prefix
— blobsy does not delete old versions from remote during normal sync).

**`git rebase` / `git cherry-pick` with pointer conflicts.** Pointer files can conflict
during rebase just like any other file.
Standard git conflict resolution applies.
After resolving, run `blobsy status` to verify the pointer is consistent with local
data, and `blobsy push` if needed.

**Manually edited `.blobsy` pointer file.** If a user or tool modifies the hash, size,
or other fields in a pointer file, `blobsy status` may show incorrect state.
`blobsy verify` detects mismatches between the pointer hash and the actual local file.
`blobsy push` recalculates the hash and overwrites the pointer with correct values.

### Credential and Backend Errors

**Missing or expired credentials.** `blobsy push` and `blobsy pull` fail with an
authentication error from the underlying transport tool (aws-cli, rclone, or the
built-in SDK). The error message comes from the transport layer, not from blobsy.

Recovery: configure credentials via the standard mechanism for the backend (environment
variables, `~/.aws/credentials`, IAM roles, rclone config).

**`sync.tool: auto` selects the wrong tool.** A user has aws-cli installed for other
purposes, but it’s not configured for the blobsy backend’s endpoint or region.
Auto-detection picks aws-cli, which fails.

Mitigation: set `sync.tool` explicitly in config (e.g., `sync.tool: built-in`) to bypass
auto-detection. Or configure aws-cli for the target endpoint.

## Sync Semantics

### Push (Local to Remote)

**Single files:**
1. Hash local file.
2. Compare against hash recorded in `.blobsy` pointer.
3. If different: upload to remote prefix, update `.blobsy` pointer.
4. User commits updated `.blobsy` files to git.

**Directories (with manifest, default):**
1. Scan local directory (applying ignore patterns from config, if any).
2. Fetch remote manifest from resolved prefix.
3. `stat()` each local file and compare against the local stat cache.
   Files where `size` + `mtime_ms` match the cache: use cached `sha256` (no read).
   Files where stat differs or no cache entry: read and hash (SHA-256), update cache.
4. Compare local hashes and sizes against manifest: identify new, changed, and deleted
   files. Files where the hash matches the manifest are skipped (no re-upload).
5. Upload changed/new files, remove deleted files from remote.
6. Rewrite remote manifest with updated per-file hashes and sizes.
   Manifest is written as a single object PUT (atomic on S3-compatible stores).
7. Update `updated` timestamp in `.blobsy` pointer only after manifest write succeeds.

**Idempotency and partial failure:** If push is interrupted, the remote manifest still
reflects the last complete push.
Re-running push is safe: already-uploaded files are detected via hash comparison and
skipped. If the remote already has the expected object (hash matches), upload is skipped
even if the pointer was updated — this supports merge/promotion workflows where data
exists in one prefix but needs to appear in another.

**Directories (without manifest):**
1. Delegate to transport tool (`aws s3 sync`, `rclone sync`) targeting the resolved
   prefix.
2. Transport tool handles change detection and incremental transfer.
3. Update `updated` timestamp in `.blobsy` pointer.

### Pull (Remote to Local)

**Single files:**
1. Check if local file exists and matches pointer hash.
2. If missing or different from pointer: download from resolved prefix.
3. If the local file has been modified (hash differs from both pointer and remote), pull
   fails with exit code 2. Use `--force` to overwrite local modifications.

**Directories (with manifest, default):**
1. Fetch remote manifest from resolved prefix.
2. Compare local files against manifest using size and hash (applying ignore patterns
   from config, if any).
   Files where the hash matches are skipped.
3. Download missing or changed files (only non-ignored files).
4. Pull does not delete local files that are absent from the manifest.
   Extra local files are left untouched.

**Directories (without manifest):**
1. Delegate to transport tool (reverse direction).
2. Transport tool handles change detection.

### Conflict Detection

**Single-writer model (V1):** blobsy assumes one writer per prefix at a time.
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

`blobsy sync` (bidirectional: pull then push) is deferred from V1 scope.
The interaction between pull-delete and push-delete semantics is underspecified and
potentially dangerous.
`push` and `pull` cover the common workflows; bidirectional sync will be revisited once
delete semantics and conflict handling are fully resolved.

For reference, the intended design is: `blobsy sync` = pull then push, with configurable
conflict resolution (`--strategy error|local-wins|remote-wins`).

## Versioning and Branch Lifecycle

### How Versioning Works

`blobsy` does not implement its own version history.
Git provides it. Namespaces provide branch isolation.

When you `blobsy push`, the pointer file’s hash and timestamp update.
You commit those changes to git.
`git log data/prices.parquet.blobsy` shows the version history of pointer changes.

**Important:** Remote prefixes hold the latest pushed state only.
Checking out an old pointer and running `blobsy pull` will only succeed if the prefix
hasn’t been overwritten by a subsequent push.
This is not a design guarantee — it depends on whether the remote data happens to still
match the old pointer.
For reliable file-level history, enable S3 bucket versioning or use an explicit version
prefix (e.g., `versions/v2.1`).

A future V2 opt-in mode (commit-prefixed versioned storage) will enable full
reproducibility. See the Future Extensions (V2) section.

### Branch Merge and Cleanup

When a feature branch is merged and deleted locally, its remote prefix
(`branches/feature-x/`) remains.
This is by design — remote data is never deleted implicitly.

Use `blobsy gc` to clean up stale prefixes:

```bash
# Preview what would be removed
$ blobsy gc --dry-run
Would remove: branches/feature-x/  (20.2 MB, no local branch, last updated 14d ago)
Would remove: branches/old-exp/    (5.1 MB, no local branch, last updated 45d ago)
Skipping:     branches/main/       (local branch exists)
Skipping:     shared/              (literal prefix, not a branch prefix)

# Remove prefixes older than 30 days with no local branch
$ blobsy gc --older-than 30d
Removed: branches/old-exp/ (5.1 MB)
Skipping: branches/feature-x/ (last updated 14d ago, newer than 30d)
Done. 1 prefix removed, 5.1 MB freed.

# Force remove all stale prefixes
$ blobsy gc --force
Removed: branches/feature-x/ (20.2 MB)
Removed: branches/old-exp/ (5.1 MB)
Done. 2 prefixes removed, 25.3 MB freed.
```

`gc` only removes prefixes under `branches/` that have no corresponding local or
remote-tracking Git branch, and `detached/` prefixes older than a configurable TTL
(default: 7 days), since CI and ephemeral checkouts can create many of these.
Literal prefixes (e.g., `shared/`, `versions/v2.1/`) are never touched by gc.

## Agent and Automation Integration

### Machine-Readable Output

All commands support `--json`. JSON output includes a `schema_version` field (e.g.,
`"schema_version": "0.1"`) so automation can detect breaking changes:

```bash
$ blobsy status --json
{
  "schema_version": "0.1",
  "prefix_template": "branches/{branch}",
  "resolved_prefix": "branches/main/",
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
      "prefix": "branches/{branch}"
    }
  ]
}
```

```bash
$ blobsy ns ls --json
{
  "prefixes": [
    {
      "prefix": "branches/main/",
      "template": "branches/{branch}",
      "targets": 3,
      "total_size": 120400000,
      "updated": "2026-02-18T12:00:00Z",
      "has_local_branch": true
    },
    {
      "prefix": "shared/",
      "template": "shared",
      "targets": 1,
      "total_size": 45000000,
      "updated": "2026-02-18T12:00:00Z"
    }
  ]
}
```

### Self-Documenting Pointer Files

Every `.blobsy` file starts with:

```
# This is a large object reference file.
# Run npx blobsy@latest --help for more on using blobsy.
```

An agent encountering a `.blobsy` file for the first time can read this header, run the
help command, and understand the system without external documentation.

### Idempotency

All commands are safe to run repeatedly:
- `blobsy pull` when already up-to-date: no-op.
- `blobsy push` when remote matches: no-op.
- `blobsy track` on already-tracked path: updates pointer, no error.

### Non-Interactive by Default

All sync operations (`push`, `pull`, `status`, `diff`, `verify`, `gc`) are fully
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
The only persistent local state is the stat cache (`.blobsy/cache/`), which is a pure
optimization — if missing, all operations still work correctly, just slower.

### Testing

The `local` backend makes testing trivial.
Integration tests use a temp directory as the “remote.”
No cloud account needed for development.

## Scope Boundaries (V1)

What `blobsy` does:
- Track files and directories via `.blobsy` pointer files
- Template-based namespace prefixes (`branches/{branch}`, literal prefixes like
  `shared`)
- Push/pull sync with pluggable backends
- Remote manifests for directory sync coordination
- SHA-256 integrity verification (pointer hashes for files, manifest hashes for
  directories)
- Prefix garbage collection
- Hierarchical configuration with per-pointer overrides
- Gitignore management
- Machine-readable output for agents

What `blobsy` does not do (V1):
- Compression (files stored as-is; see Future Extensions for V2 plans)
- Versioned/reproducible storage (remote holds latest state per prefix only; see Future
  Extensions for V2 commit-prefixed blob storage)
- Bidirectional sync (deferred until delete semantics are resolved; use `push`/`pull`)
- Sub-file delta sync (whole-file granularity only)
- Cross-repo deduplication
- Cross-prefix deduplication (branch A and B store separate copies)
- Access control (relies on backend IAM)
- Lazy materialization (pull downloads everything)
- Content-addressable storage (path-mirrored only)
- Multi-writer merge logic
- Signed manifests or end-to-end cryptographic verification chains
- Remote staleness detection via provider hashes (storing ETags/CRC64NVME from upload
  responses for cheap `HeadObject`-based checks — see Integrity Model section)
- Web UI

These are candidates for future versions if demand warrants.

## Future Extensions (V2)

This section outlines planned V2 features that are explicitly out of V1 scope.
They are documented here to ensure V1’s design is forward-compatible and to provide a
roadmap for future development.

### V2 Phase 1: Compression

**Motivation:** Files stored as-is in V1 means larger remote storage and slower
transfers for compressible data.
Compression is the highest-value V2 feature and should be the first addition after V1
ships.

**Planned design:**

Per-file compression before upload, decompression after download.
The user never sees compressed files locally.

- Default algorithm: `zstd` at level 3 (fast compression, ~3x ratio on text, 800+ MB/s
  decompression).
- Pluggable algorithms: `zstd`, `gzip`, `lz4`, `none`, `command` (custom).
- Skip list: Already-compressed formats (JPEG, PNG, MP4, etc.)
  stored as-is. Must be in repo-level config (affects remote keys).
- Remote filenames: Compressed files get a `.zst` suffix (or `.gz`, `.lz4`). The
  manifest tracks `stored_as` for each file entry.
- Staging approach: file-by-file orchestration (compress → upload → next file) avoids
  doubling disk usage.

**V1 compatibility:** V1 manifests and pointers have no compression fields.
Adding compression in V2 means the pointer format gains a `compression` field and
manifests gain `stored_as` entries.
V1 pointers without these fields are implicitly `compression: none`, so the transition
is backward-compatible.

### V2 Phase 2: Commit-Prefixed Versioned Storage

**Motivation:** V1’s path-mirrored layout (Promise A) means remote prefixes hold only
the latest pushed state.
Old versions are lost when overwritten by a subsequent push.
For teams that need reproducibility — the ability to reconstruct exact data states from
old commits — a versioned storage layer is needed.

**Design: commit-hash-prefixed blobs.**

This approach extends V1’s branch prefix model naturally.
Instead of storing files at `branches/main/data/prices.parquet` (overwritten on each
push), files are stored under the git commit hash that was HEAD at push time:

```
s3://bucket/prefix/
  blobs/
    a1b2c3d4/data/prices.parquet        <- pushed at commit a1b2c3d4
    a1b2c3d4/data/research-batch/
      report.md
      raw/response.json
    e5f6a7b8/data/prices.parquet        <- modified at commit e5f6a7b8
  manifests/
    branches/main/current.json          <- maps paths to blob prefixes
```

**How it works:**

1. On `blobsy push`, blobsy records `git rev-parse HEAD` as the blob prefix.
2. Only changed files get new blobs under the new commit prefix.
   Unchanged files retain their existing blob prefix from a prior push.
3. The manifest maps each path to its blob prefix:

```json
{
  "format": "blobsy-manifest/0.2",
  "updated": "2026-02-18T12:00:00Z",
  "storage": "versioned",
  "files": [
    {
      "path": "data/prices.parquet",
      "blob_prefix": "e5f6a7b8",
      "size": 16100000,
      "sha256": "..."
    },
    {
      "path": "data/research-batch/report.md",
      "blob_prefix": "a1b2c3d4",
      "size": 4096,
      "sha256": "..."
    }
  ]
}
```

4. On `blobsy pull`, the manifest resolves each path to its blob location.
5. Historical manifests are preserved (keyed by commit hash), enabling reconstruction of
   any past state.

**Key properties:**

- **Natural dedup:** Only changed files get new blobs.
  Unchanged files across commits (and across branches forked from the same commit) share
  the same blob. This also solves the V1 pain point where the first push on a new branch
  re-uploads everything.
- **Browsable:** Files are stored by path under a commit prefix, so
  `aws s3 ls s3://bucket/prefix/blobs/a1b2c3d4/` shows real files with real names.
  Pipelines need the manifest to find the right blob prefix, but the manifest is a
  simple JSON file any system can read.
- **Fully reproducible:** Any historical manifest reconstructs the exact data state.
  Checking out an old pointer and pulling actually works reliably (unlike V1 where it
  depends on the prefix not having been overwritten).
- **Incremental:** Push only uploads blobs that changed.
  The manifest is the only thing rewritten per push.
- **Clean extension of V1:** V1’s `branches/main/data/prices.parquet` layout is a
  special case where every file has the same blob prefix (the resolved namespace
  prefix). V2 generalizes this to per-file prefixes based on last-modified commit.

**Opt-in:** Versioned storage is enabled via config (`storage: versioned`). V1-style
path-mirrored storage remains the default for simplicity.

**Garbage collection:** With versioned blobs, GC needs to walk all manifests to find
which blobs are still referenced.
Unreferenced blobs (from old commits whose manifests have been pruned) can be deleted.
More complex than V1’s prefix-based deletion but well-understood (similar to git’s
object GC).

**Compression interaction:** When both compression and versioned storage are enabled,
compressed blobs get the `.zst` suffix under their commit prefix (e.g.,
`blobs/a1b2c3d4/data/prices.parquet.zst`). The manifest’s `stored_as` field resolves the
full remote key.

### V2: Other Candidates

These are additional V2 candidates recorded from design reviews.
They are independent of the phased compression and versioned storage features above.

- **Cross-prefix dedup:** In V1, creating a new branch re-uploads all data.
  Versioned storage (above) solves this naturally.
- **Remote staleness detection via provider hashes:** Store ETag/CRC from upload
  responses for cheap `HeadObject`-based checks.
  See Integrity Model section.
- **Bidirectional sync (`blobsy sync`):** Pull-then-push with configurable conflict
  resolution. Blocked on delete semantics resolution.
- **Lazy materialization:** Pull specific files from a directory without downloading
  everything.
- **Dictionary compression:** zstd dictionary training for 2-5x improvement on small
  files sharing structure.
- **Sub-file delta sync:** Transfer only changed portions of large files.

## Review Issues Tracker

This section tracks all issues raised across three external design reviews:

- [Round 1: General review](blobsy-design-review-round1-general.md) (22 issues: C1-C4,
  S1-S7, M1-M11)
- [Round 2: Checksum deep-dive](blobsy-design-review-round2-checksums.md) (reframes C1
  and S3)
- [Round 3: GPT5Pro architecture review](blobsy-design-review-round3-gpt5pro.md) (33
  actionable items)

All issues are tracked under epic `blobsy-0itg` ("Design spec review issues (rounds
1-3)").

### Addressed Issues

These issues have been resolved in the current spec.
Listed for traceability; no further action needed.

| Bead | Review IDs | Resolution |
| --- | --- | --- |
| *(spec)* | R1 C1, R2 C1, R3 §3 | **Directory integrity model.** Per-file SHA-256 in manifest, two-tier change detection (stat cache + hash), mtime removed from remote manifest. See Integrity Model and Local Stat Cache sections. |
| `blobsy-suqh` | R1 C3, R3 §4.9 | **Interactive init contradiction.** Clarified: `init` is interactive without flags, all sync ops are non-interactive. See Non-Interactive by Default section. |
| `blobsy-br1a` | R1 C4, R3 §5 | **`blobsy sync` bidirectional.** Deferred from V1 scope. See Bidirectional Sync section. |
| *(spec)* | R1 S3, R2 | **mtime unreliability.** Resolved by stat cache design: mtime used only in local cache (per-machine), never in remote manifest. See Local Stat Cache section. |
| `blobsy-r34j` | R1 S2 | **gc safety.** `blobsy gc` checks remote tracking branches, not just local. |
| `blobsy-jlcn` | R1 M1, R3 §4.1 | **Pointer field types.** sha256 = 64-char lowercase hex, size = bytes, timestamps = ISO 8601 UTC Z. See Pointer File Format section. |
| `blobsy-n23z` | R1 M2 | **Format versioning.** `<name>/<major>.<minor>`, reject on major mismatch, warn on newer minor. See Pointer File Format section. |
| `blobsy-0a9e` | R1 M3, R3 §4.10 | **Command backend template variables.** `{local}`, `{remote}`, `{relative_path}`, `{namespace}`, `{bucket}` specified. Runs once per file. See Backend System section. |
| `blobsy-srme` | R1 M4, R3 §4.8 | **Which .gitignore.** Same directory as tracked path, following DVC convention. See Gitignore Management section. |
| `blobsy-v9py` | R1 M5, R3 §4.3 | **Detached HEAD.** 12-char SHA prefix, gc covers `detached/` prefixes with TTL. See Namespace Prefix section. |
| `blobsy-bnku` | R1 M7, R3 §4.4 | **Push idempotency.** Atomic manifest write; re-run is safe. See Sync Semantics section. |
| `blobsy-q6xr` | R3 §4.4 | **Pull behavior on local mods.** Default: error on modified files unless `--force`. See Pull section. |
| `blobsy-p8c4` | R3 §4.2 | **`stored_as` in manifest.** Deferred to V2 (no compression in V1 means remote key = path). Will be needed when compression adds `.zst` suffixes. |
| `blobsy-txou` | R3 §4.2 | **Manifest canonicalization.** Fixed key order, sorted file entries, consistent LF, no trailing whitespace. See Manifests section. |
| `blobsy-v6eb` | R3 §4.1 | **Stable pointer key ordering.** Keys written in documented fixed order to minimize git diff noise. See Pointer File Format section. |
| `blobsy-fjqj` | R3 §4.7 | **Compression skip list in repo config.** Deferred to V2 with compression. |
| `blobsy-mg0y` | R3 §4.9 | **`--json` schema version.** `schema_version` field in all JSON output. See Agent and Automation Integration section. |
| `blobsy-pice` | R3 §4 | **SDK endpoint wording.** `@aws-sdk/client-s3` uses config object, not CLI flags. See S3-Compatible Backends section. |
| *(spec)* | R2 | **Checksum algorithm simplification.** Dropped md5 and xxhash from V1; `sha256` (default) and `none` only. See Integrity Model section. |
| *(spec)* | R3 §4.4 | **Pull does not delete local files.** Extra local files not in manifest are left untouched. See Pull section. |
| `blobsy-cx82` | R3 §1 | **Versioning semantics.** Promise A for V1 (branch-isolated sync, latest state per namespace). Promise B language removed. Bucket versioning recommended for history. V2 commit-prefixed blobs planned for full reproducibility. See Versioning and Branch Lifecycle and Future Extensions sections. |

### Open P0 — Must Resolve Before Implementation

These are blocking design decisions.
Each requires a clear resolution before the corresponding feature can be implemented.

#### Versioning semantics (`blobsy-cx82`) — RESOLVED

**Review IDs:** R3 §1 (P0-1)

**Decision: Promise A for V1.** See Addressed Issues table above for full resolution.
Promise B language removed from spec.
V2 commit-prefixed versioned storage planned for full reproducibility (see Future
Extensions).

#### `manifest_sha256` content identifier for directory pointers (`blobsy-mlv9`)

**Review IDs:** R3 §3 (P0-3), R3 §4.2

Directory pointers currently have only an `updated` timestamp — git diff and merge are
meaningless on timestamps alone.
Add `manifest_sha256` (hash of the canonical manifest JSON), plus optionally
`file_count` and `total_size`, so that:

- `git diff` shows meaningful changes when directory contents change.
- Conflict detection can use `manifest_sha256` in the pointer as baseline (avoids
  needing remote ETag or separate local state for “last seen manifest”).
- Merge operations on pointers are well-defined.

#### Branch merge/promotion workflow (`blobsy-a64l`)

**Review IDs:** R3 §2 (P0-2)

When a feature branch merges into main via PR, the pointer file lands on main but the
data stays in `branches/feature-x/`. Users on main can’t `blobsy pull` — the data
doesn’t exist in `branches/main/`.

Options:

- Add explicit `blobsy promote` or `blobsy ns copy` command for post-merge data
  promotion.
- Have `blobsy push` detect missing remote objects for the current prefix and re-upload
  from local.
- Add `blobsy check-remote` CI verifier that fails the merge if data isn’t in the target
  prefix.

#### Delete semantics (`blobsy-05j8`)

**Review IDs:** R3 §4.2 (4.2-4)

The spec contains a contradiction: “blobsy never deletes remote objects during normal
sync operations” vs.
push step 5 which says “remove deleted files from remote.”

Resolve by choosing one of:

- Push does not delete remote files by default.
  Explicit `--prune` flag to enable deletion.
- Push always syncs deletions but warns when files are removed.
- Tombstones in manifest with separate `blobsy gc` for actual deletion.

Related: deletion semantics affect the deferred `blobsy sync` bidirectional feature and
whether old directory states are reconstructible.

#### Single-file conflict detection scope (`blobsy-7h13`)

**Review IDs:** R1 C2, R3 §3 (P0-4)

The design references comparing against a “remote hash” but doesn’t specify how to
obtain it without downloading the file.
Options:

- Store SHA-256 as S3 object metadata (`x-amz-meta-sha256`) on upload, retrieve via
  HEAD.
- Store a sidecar `<file>.sha256` file alongside the remote object.
- Drop remote conflict detection from V1 entirely.
  Rely on pointer workflow discipline + optional `blobsy check-remote` in CI.

Given the single-writer model and the complexity of portable metadata across aws-cli,
rclone, and custom backends, the round 3 review recommends deferring this.

#### Compression + transfer mechanics (`blobsy-lsu9`) — DEFERRED TO V2

**Review IDs:** R3 §4.7 (P0-5, 4.7-1)

Compression is deferred from V1 (files stored as-is).
This issue becomes relevant when compression is introduced in V2. See Future Extensions
(V2) for planned compression design.

#### Atomic writes for built-in transport (`blobsy-rel2`)

**Review IDs:** R3 §4.5 (4.5-1)

`aws-cli` and `rclone` handle atomic writes internally.
The built-in `@aws-sdk` engine does not — blobsy must implement temp-file-then-rename
for:

- Local file writes during pull (avoid partial files on interrupt).
- Pointer file updates.
- Stat cache writes.

Also: define `blobsy clean` command for cleaning up orphaned temp files
(`.blobsy-tmp-*`), and document expected interrupted-state behavior (partial file set
may exist; rerun fixes).

#### Security: command execution from repo config (`blobsy-vj6p`)

**Review IDs:** R3 §4.10 (4.10-1)

Repo-level config can specify `command` backends.
Running `blobsy pull` on a cloned repo could execute arbitrary commands from the repo’s
`.blobsy/config.yml`. (In V2, custom compression commands will also be a concern.)

Recommended approach: disallow `command` backend from repo-level config by default.
Allow only in user-level config (`~/.config/blobsy/`) or via explicit `blobsy trust` per
repo. Warn on first use.

### Open P1 — Should Resolve for V1 Ship Quality

#### Branch name sanitization (`blobsy-u4cs`)

**Review IDs:** R1 S1, R3 §4.3 (4.3-1)

Branch names can contain slashes, spaces, special characters.
Define normalization rules for S3 key safety: preserve `/`, percent-encode characters
outside `[a-zA-Z0-9/._-]`, specify max length with hash fallback for pathological branch
names.

#### Auto tool detection robustness (`blobsy-y72s`)

**Review IDs:** R1 S7, R3 §4.6 (4.6-1)

`sync.tool: auto` must do a capability check (credentials + reachability), not just
binary existence. If aws-cli is installed but not configured, fall through to rclone,
then built-in.
Add `blobsy doctor` command that prints: detected backend, selected tool +
why, resolved prefix.

#### Explicit version prefix usage (`blobsy-q2dd`)

**Review IDs:** R1 S4, R3 §4.3 (4.3-3)

When using a literal version prefix (e.g., `versions/v2.1`), the prefix must be set
explicitly in config or via `--prefix`. Version prefixes accumulate forever by default.
Provide `blobsy ns rm versions/<id>` for explicit cleanup.
Consider whether `blobsy gc` should have a `--include-versions` flag.

#### Multi-prefix output grouping

**Review IDs:** R1 S5, R3 §4.3 (4.3-4)

When per-pointer prefix overrides create mixed prefixes in a single operation,
`blobsy status` and `blobsy push` should group output by resolved prefix.
Each prefix group succeeds or fails independently.
Decide whether this complexity is justified for V1 or whether per-pointer prefix
overrides should be deferred.

#### Versioned metadata vs local preferences

**Review IDs:** R3 §4.1 (4.1-2)

Any setting that affects how remote bytes are stored must be in git-tracked state
(pointer or repo config), not in global/user config.
Specifically: checksum algorithm and namespace prefix affect remote keys.
If two users have different local configs, they produce different remote
representations, breaking sync.
(In V2, compression algorithm and skip-list will also be remote-affecting settings that
must be in git-tracked config.)

#### `blobsy status` offline vs online

**Review IDs:** R3 §4.4 (4.4-3)

Define clearly whether `blobsy status` requires fetching the remote manifest (online) or
operates purely against the pointer and local stat cache (offline).
Consider providing `status --offline` that compares local files to the pointer (single
file) or locally cached manifest without network access.

### Deferred Considerations (P2 / V2)

Items below are not blocking V1 but are recorded for future reference.

#### Compression suffix convention

**Review IDs:** R1 S6, R3 §4.7

Three options: (1) accept `.zst` ambiguity, rely on manifest metadata (simplest); (2)
use `.blobsy.zst` suffix; (3) store compression state in manifest only, not filename.
Round 3 review leans toward option 1 as adequate.
Decision should be made explicitly.

#### Small-file compression threshold

**Review IDs:** R3 §4.7 (4.7-3)

Compression overhead on tiny files can be counterproductive.
Consider a default threshold (e.g., skip files < 4 KB) or make configurable.
Quality-of-life optimization, not correctness.

#### Dictionary compression

**Review IDs:** R1 M8

zstd dictionary training provides 2-5x improvement for small files (< 64 KB) sharing
structure (common with JSON/YAML datasets).
Design the compression interface to support this later (e.g., a `dictionary` field in
config). Deferred to V2.

#### Export/import specification

**Review IDs:** R1 M6

`blobsy export` / `blobsy import` are underspecified: does the archive include pointer
files? Does import create pointers and gitignore entries?
Flat dump or preserved directory structure?
Seekable zstd for large archives?
Needs specification before implementation.

#### Integration surface: library vs CLI

**Review IDs:** R1 M10, R3 §7

State explicitly whether blobsy is standalone CLI only or also exposes a programmatic
API via the npm package.
The current design implies CLI-only.

#### Mixed directories: ignore vs include patterns

**Review IDs:** R3 §4.8 (4.8-2)

The ignore-pattern model requires manual `.gitignore` adjustment for mixed directories
(known sharp edge). An include-pattern model where blobsy tracks only matching files
might be less error-prone.
Current approach works; revisit if users find it confusing.

#### `command` backend as integration point

**Review IDs:** R1 M11

The `command` backend could serve as a deliberate integration point for domain-specific
tools, not just an escape hatch.
Security restrictions (`blobsy-vj6p`) must be resolved first.

#### s5cmd and future transport engines

**Review IDs:** R3 §5

s5cmd is a high-performance batching tool worth considering, especially for
manifest-driven file-by-file orchestration.
Track as the transfer architecture solidifies.

#### Team adoption workflow

**Review IDs:** R1 M9

The spec doesn’t address how team members discover they need to run `blobsy pull`, CI
integration patterns, or the “committed pointer with no remote data” failure mode.
Add a “Team Workflows” section with guidance once core features are stable.

#### `blobsy verify` for directories

**Review IDs:** R2

Implement `blobsy verify` for directory targets using per-file manifest hashes.
Not a V1 launch blocker but straightforward once manifest hashes exist.
Related: a `verify_after_pull` config flag (default false) for users who want post-pull
integrity checks beyond what the transport layer provides.

#### `ns ls` performance with sizes

**Review IDs:** R3 §5

Listing prefix sizes requires walking all objects in each prefix, which can be slow and
expensive on large buckets.
Consider deferring size reporting from `blobsy ns ls` or making it opt-in (`--sizes`).
Ship the basic listing (prefix names + timestamps) first.
