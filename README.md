# blobsy

Store large files anywhere.
Track them in Git.

A simpler, more flexible, serverless alternative to Git LFS. Blobsy is a standalone CLI
that tracks large files with lightweight `.bref` pointer files committed to Git, while
the actual data lives in any storage backend -- S3, local directories, or custom
commands. No special server.
No hosting requirements.

## Quick Start

```bash
# Install
npm install -g blobsy

# Initialize in a git repo
cd my-project
blobsy init s3://my-bucket/my-project/blobs/

# Add files: externalizes large (by default >1MB) files, stages everything to git
blobsy add data/
```

```
Scanning data/...
  data/model.bin         (500 MB)  -> tracked (.bref)
  data/config.json       (  2 KB)  -> kept in git
  data/notes.txt         (500  B)  -> kept in git
1 file externalized, 2 kept in git.
Staged 4 files (1 .bref, 1 .gitignore, 2 kept in git).
Changes have been staged to git: run `git status` to review and `git commit` to commit.
```

```bash
# Review what was staged, then commit and push
git status
git commit -m "Track large files with blobsy"
git push                    # pre-push hook auto-uploads blobs

# On another machine, pull blobs back
git clone <repo>
cd <repo>
blobsy pull
```

`blobsy add` scans a directory (or accepts specific files/subdirectories), creates
`.bref` pointer files for large files, adds originals to `.gitignore`, and stages
everything to git. By default, files **1 MB or larger** are externalized; smaller files
are staged directly to git.
See [Externalization Rules](#externalization-rules) for details.

## How It Works

1. `blobsy add` scans your files and decides which to externalize (based on size and
   [rules](#externalization-rules))
2. Large files get a `.bref` pointer file and are added to `.gitignore`
3. Small files and `.bref` pointers are staged to git automatically
4. You commit the staged changes (`git commit`)
5. `blobsy push` uploads blobs to your configured backend
6. `blobsy pull` downloads blobs on another machine using the `.bref` metadata
7. Content-addressable storage (SHA-256) means identical files are never uploaded twice

For fine-grained control, `blobsy track` does step 1-2 without git staging — you then
`git add` manually.

A `.bref` file after `track` (before push):

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.1
hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
size: 1048576
```

After `push`, it gains a `remote_key`:

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.1
hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
size: 1048576
remote_key: 20260221T120000Z-e3b0c44298fc/data/model.bin
```

## Commands

| Command | Description |
| --- | --- |
| `blobsy init <url>` | Initialize blobsy with a backend URL |
| `blobsy add <path...>` | Track files and stage changes to git (recommended) |
| `blobsy track <path...>` | Track files without git staging (low-level) |
| `blobsy untrack <path...>` | Stop tracking (keep local files) |
| `blobsy push [path...]` | Upload local blobs to remote |
| `blobsy pull [path...]` | Download remote blobs to local |
| `blobsy sync [path...]` | Bidirectional sync (push + pull) |
| `blobsy status [path...]` | Show state of tracked files |
| `blobsy verify [path...]` | Verify local files match ref hashes |
| `blobsy rm <path...>` | Remove from tracking and delete local file (use `--remote` to also delete from backend, `--local` to keep .bref) |
| `blobsy mv <src> <dest>` | Rename or move a tracked file |
| `blobsy config [key] [val]` | Get or set configuration |
| `blobsy health` | Check backend connectivity |
| `blobsy doctor [--fix]` | Diagnostics and self-repair |
| `blobsy hooks <action>` | Install or uninstall git hooks (pre-commit, pre-push) |
| `blobsy check-unpushed` | List committed .bref files missing remote blobs |
| `blobsy pre-push-check` | CI guard: fail if any .bref lacks remote blob |
| `blobsy skill` | Output skill documentation for AI agents |
| `blobsy prime` | Output context primer for AI agents |

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

**Note:** The directory will be created automatically during `blobsy init` if the parent
directory exists.

### Custom Command

```yaml
backends:
  default:
    type: command
    push_command: "rclone copyto {local} remote:{remote}"
    pull_command: "rclone copyto remote:{remote} {local}"
    exists_command: "rclone lsf remote:{remote}"
```

Command backends execute user-configured shell commands for push/pull/exists operations.

**Switching Backends:** If you change the backend URL in `.blobsy.yml`, tracked files
will continue to reference their existing remote keys.
To migrate files to a new backend, you must manually re-push them with
`blobsy push --force`.

## Externalization Rules

When you run `blobsy add <directory>` (or `blobsy track <directory>`), blobsy decides
per-file whether to externalize based on these rules (checked in order):

1. **`never` patterns** (highest priority) -- matching files stay in git
2. **`always` patterns** -- matching files are externalized regardless of size
3. **`min_size` threshold** (default: `1mb`) -- files at or above this size are
   externalized

Configure in `.blobsy.yml` at your repo root:

```yaml
externalize:
  min_size: 1mb           # default; accepts units like 500kb, 2mb, 1gb
  always:
    - "*.bin"
    - "*.onnx"
    - "*.safetensors"
  never:
    - "*.md"
    - "*.json"
```

**Note:** Tracking a specific file by name (`blobsy add data/model.bin`) always
externalizes it, bypassing these rules.

## Git Hooks

Blobsy installs two git hooks by default (via `blobsy init`):

| Hook | When | What it does |
| --- | --- | --- |
| **pre-commit** | `git commit` | Verifies staged `.bref` files match their local files (catches modifications after tracking) |
| **pre-push** | `git push` | Auto-runs `blobsy push` to upload any unpushed blobs (ensures blobs and refs arrive together) |

**Opting out:**

- Skip during init: `blobsy init --no-hooks s3://...`
- Bypass once: `git commit --no-verify` or `git push --no-verify`
- Disable via environment: `BLOBSY_NO_HOOKS=1`
- Remove entirely: `blobsy hooks uninstall`

If you use a hook manager (lefthook, husky), blobsy skips auto-installation and tells
you what to add to your config:

```bash
# In your hook manager config:
blobsy hook pre-commit    # pre-commit hook
blobsy hook pre-push      # pre-push hook
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

Ensure all committed `.bref` files have their blobs pushed before CI runs:

```bash
# Locally, before pushing to Git
blobsy check-unpushed    # List any .bref files missing remote blobs
blobsy push              # Upload missing blobs

# In CI pipeline (fails build if blobs missing)
blobsy pre-push-check
```

**Workflow:** `blobsy add` → `git commit` → `blobsy push` → `git push` → CI runs
`pre-push-check`

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
| Git integration | `.bref` pointer files | Filter driver | `.dvc` pointer files |
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
