# blobsy User Guide

For command reference, run `blobsy --help` or `blobsy <command> --help`.

## Conceptual Model

Blobsy tracks large files with lightweight `.bref` pointer files committed to Git.
The actual data (blobs) lives in remote storage — S3, local directories, or custom
command backends.

The lifecycle:

1. `blobsy track <file>` — hashes the file, writes a `.bref` pointer, gitignores
   original
2. `blobsy push` — uploads the blob to remote, records `remote_key` in `.bref`
3. `blobsy pull` — downloads blobs using `.bref` metadata

Content-addressable storage: SHA-256 hashing means identical files produce the same
blob. Pushing the same content twice is a no-op.

The recommended workflow uses `blobsy add` (which tracks + git stages in one step):

```bash
blobsy add data/
git commit -m "Track large files"
git push          # pre-push hook auto-uploads blobs
```

## Configuration

Configuration lives in `.blobsy.yml` files.
Five levels, bottom-up resolution:

```
(blobsy built-in defaults)           Hardcoded in blobsy
~/.blobsy.yml                        User-global defaults
<repo>/.blobsy.yml                   Repo root
<repo>/data/.blobsy.yml              Subdirectory override
<repo>/data/raw/.blobsy.yml          Deeper override
```

Merge semantics: shallow replace (not deep-merge).
A subdirectory config replaces the entire array/object, not individual elements.

Important: Settings affecting remote storage (compression algorithm, checksum) must be
in repo-level config (committed to git), not user-global config.

## Built-in Defaults

```yaml
externalize:
  min_size: 200kb
  always: []
  never: []
compress:
  algorithm: zstd
  min_size: 100kb
  always: ["*.json", "*.csv", "*.tsv", "*.txt", "*.jsonl", "*.xml", "*.sql"]
  never: ["*.gz", "*.zst", "*.zip", "*.tar.*", "*.parquet", "*.png", "*.jpg", "*.jpeg", "*.mp4", "*.webp", "*.avif"]
remote:
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"
sync:
  tools: ["aws-cli", "rclone"]
  parallel: 8
checksum:
  algorithm: sha256
ignore:
  - "node_modules/**"
  - ".git/**"
  - ".blobsy/**"
  - "*.tmp"
  - "dist/**"
  - "build/**"
  - "__pycache__/**"
  - "*.pyc"
  - ".DS_Store"
```

## Externalization Rules

When tracking a directory (`blobsy track <dir>` or `blobsy add .`), blobsy decides
per-file whether to externalize.
Rules checked in order:

1. `never` patterns (highest priority) — matching files stay in git
2. `always` patterns — matching files externalized regardless of size
3. `min_size` threshold (default: 200kb) — files at or above this size externalized

When tracking a specific file by name, it is always externalized (rules bypassed).

Example configuration:

```yaml
externalize:
  min_size: 500kb
  always:
    - "*.parquet"
    - "*.weights"
  never:
    - "*.md"
    - "config/**"
```

Use `--min-size` to override the threshold for a single invocation:

```bash
blobsy track --min-size 100kb data/
```

## Compression

Blobsy compresses blobs before upload and decompresses on pull.
Algorithms: zstd (default), gzip, brotli, or none.

```yaml
compress:
  algorithm: zstd
  min_size: 100kb
  always: ["*.json", "*.csv"]
  never: ["*.gz", "*.zip"]
```

The compression config must be in repo-level `.blobsy.yml` because it affects remote
keys. Files already compressed (matching `never` patterns) are uploaded as-is.

## Ignore Patterns

Files matching `ignore` patterns are skipped by `blobsy track` during directory walks.
Same syntax as `.gitignore` glob patterns.

```yaml
ignore:
  - "node_modules/**"
  - ".git/**"
  - "*.tmp"
  - "dist/**"
```

The built-in defaults skip common non-data directories.
Override with your own `ignore` list in `.blobsy.yml` (it replaces the defaults
entirely).

## Backend Configuration

Three backend types:

### S3 (and S3-compatible)

```yaml
backends:
  default:
    url: s3://my-bucket/blobs/
    region: us-east-1
```

For S3-compatible services (MinIO, Backblaze B2, etc.):

```yaml
backends:
  default:
    url: s3://my-bucket/blobs/
    endpoint: https://s3.us-west-1.backblazeb2.com
    region: us-west-1
```

### Local Directory

```yaml
backends:
  default:
    url: local:../blob-storage/
```

### Custom Command

```yaml
backends:
  default:
    url: "command:rclone copyto {local} remote:{remote}"
```

Template variables: `{local}` is the local blob path, `{remote}` is the remote key.

### Environment Override

```bash
export BLOBSY_BACKEND_URL=s3://ci-bucket/cache/
```

### Remote Key Templates

Default: `{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}`

Available variables:

- `{iso_date_secs}` — UTC timestamp (e.g. `20240115T143022Z`)
- `{content_sha256_short}` — first 12 hex chars of SHA-256
- `{repo_path}` — repo-relative file path
- `{compress_suffix}` — `.zst`, `.gz`, `.br`, or empty

## CI Integration

### Pre-push Check

```bash
# In CI pipeline:
blobsy pre-push-check
```

Fails if any committed `.bref` files reference blobs not yet uploaded.

### Syncing in CI

```bash
blobsy pull
blobsy verify
```

### Environment Override

```bash
export BLOBSY_BACKEND_URL=s3://ci-bucket/cache/
```

## Common Workflows

### Track and Push

```bash
blobsy add data/model.bin
git commit -m "Track model"
git push          # pre-push hook auto-uploads
```

### Pull After Clone

```bash
git clone <repo>
blobsy pull
blobsy verify
```

### Diagnostics

```bash
blobsy doctor --json
blobsy status --json
```

### Backend Migration

```bash
# Edit .blobsy.yml with new backend URL, then:
blobsy push --force
```
