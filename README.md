# blobsy

Store large files anywhere.
Track them in Git.

A simpler, more flexible, serverless alternative to Git LFS. Blobsy is a standalone CLI
that tracks large files with lightweight `.yref` pointer files committed to Git, while
the actual data lives in any storage backend -- S3, local directories, or custom
commands. No special server.
No hosting requirements.

## Quick Start

```bash
# Install
npm install -g blobsy

# Initialize in a git repo
cd my-project
blobsy init s3://my-bucket/blobs/

# Track large files
blobsy track data/model.bin
blobsy track assets/

# Push blobs to remote storage
blobsy push

# On another machine, pull blobs back
blobsy pull
```

## How It Works

1. `blobsy track` computes a SHA-256 hash of each file and writes a `.yref` pointer file
2. The pointer file is committed to Git; the original file is gitignored
3. `blobsy push` uploads the file to your configured backend (S3, local, etc.)
4. `blobsy pull` downloads files from remote using the `.yref` metadata
5. Content-addressable storage means identical files are never uploaded twice

A `.yref` file looks like this:

```
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
size: 1048576
remote_key: 20260221T120000Z-e3b0c44298fc/data/model.bin
```

## Commands

| Command | Description |
| --- | --- |
| `blobsy init <url>` | Initialize blobsy with a backend URL |
| `blobsy track <path...>` | Start tracking files or directories |
| `blobsy untrack <path...>` | Stop tracking (keep local files) |
| `blobsy push [path...]` | Upload local blobs to remote |
| `blobsy pull [path...]` | Download remote blobs to local |
| `blobsy sync [path...]` | Bidirectional sync (push + pull) |
| `blobsy status [path...]` | Show state of tracked files |
| `blobsy verify [path...]` | Verify local files match ref hashes |
| `blobsy rm <path...>` | Remove from tracking and delete local file |
| `blobsy mv <src> <dest>` | Rename or move a tracked file |
| `blobsy config [key] [val]` | Get or set configuration |
| `blobsy health` | Check backend connectivity |
| `blobsy doctor [--fix]` | Diagnostics and self-repair |
| `blobsy trust` | Trust repo for command backend execution |
| `blobsy hooks <action>` | Manage pre-commit hook |

### Global Options

| Option | Description |
| --- | --- |
| `--json` | Structured JSON output (for scripts and agents) |
| `--quiet` | Suppress all output except errors |
| `--verbose` | Detailed progress output |
| `--dry-run` | Show what would happen without doing it |

## Backend Configuration

Configure backends in `.blobsy.yml` at your repo root:

### S3

```yaml
backends:
  default:
    url: s3://my-bucket/prefix/
    region: us-east-1
```

For S3-compatible services (MinIO, R2, DigitalOcean Spaces):

```yaml
backends:
  default:
    url: s3://my-bucket/prefix/
    endpoint: https://minio.example.com:9000
```

### Local Directory

```yaml
backends:
  default:
    url: local:../blob-storage
```

### Custom Command

```yaml
backends:
  default:
    type: command
    push_command: "rclone copyto {local} remote:{remote}"
    pull_command: "rclone copyto remote:{remote} {local}"
    exists_command: "rclone lsf remote:{remote}"
```

Command backends require explicit trust (`blobsy trust`) since they execute shell
commands.

## Externalization Rules

Control which files get tracked automatically when using `blobsy track <directory>`:

```yaml
externalize:
  min_size: 1mb
  always:
    - "*.bin"
    - "*.onnx"
    - "*.safetensors"
  never:
    - "*.md"
    - "*.json"
```

## Compression

```yaml
compress:
  algorithm: zstd    # zstd, gzip, brotli, or none
  min_size: 100kb
  always:
    - "*.csv"
    - "*.jsonl"
  never:
    - "*.zst"
    - "*.gz"
```

## CI Integration

### Pre-push Check

Add to your CI pipeline to catch missing blobs:

```bash
blobsy pre-push-check
```

### Syncing in CI

```bash
blobsy pull          # Download all tracked files
blobsy verify        # Verify integrity
```

### Environment Override

Override the backend URL in CI without modifying `.blobsy.yml`:

```bash
export BLOBSY_BACKEND_URL=s3://ci-bucket/cache/
blobsy push
```

## Comparison with Alternatives

| Feature | blobsy | Git LFS | DVC |
| --- | --- | --- | --- |
| Server required | No | Yes (LFS server) | No |
| Backend flexibility | Any (S3, local, custom) | LFS server only | S3, GCS, local |
| Git integration | `.yref` pointer files | Filter driver | `.dvc` pointer files |
| Compression | Built-in (zstd, gzip, brotli) | None | None |
| Content-addressable | Yes (SHA-256) | Yes (OID) | Yes (MD5) |
| JSON output | Yes (`--json`) | No | Yes |
| Agent-friendly | Yes (non-interactive) | Partial | Partial |

## Development

See [docs/development.md](docs/development.md) for full setup and workflow details.

```bash
pnpm install
pnpm build
pnpm test
```

## Publishing

See [docs/publishing.md](docs/publishing.md).

## License

MIT
