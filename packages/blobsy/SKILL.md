# Blobsy Agent Skill

Git-native large file storage CLI. Track large files with `.yref` pointers in Git while
storing blobs in S3, local directories, or custom backends.

## When to Use

Use blobsy when:

- A repository contains large binary files (models, datasets, media, archives)
- Files need to be shared across machines without committing them to Git
- You need content-addressable, deduplicated blob storage
- The user mentions: blobsy, large files, blob storage, .yref, yref, externalize, Git
  LFS alternative

## Quick Reference

```bash
blobsy init <url>          # Initialize with backend URL
blobsy track <path...>     # Track files (creates .yref pointers)
blobsy push [path...]      # Upload blobs to backend
blobsy pull [path...]      # Download blobs from backend
blobsy sync [path...]      # Bidirectional push + pull
blobsy status [path...]    # Show tracked file states
blobsy verify [path...]    # Verify file integrity
blobsy untrack <path...>   # Stop tracking
blobsy rm <path...>        # Remove tracked files
blobsy mv <src> <dest>     # Move tracked files
blobsy config [key] [val]  # Show/set configuration
blobsy health              # Test backend connectivity
blobsy doctor [--fix]      # Diagnostics and repair
blobsy trust               # Trust repo for command backends
```

## Global Options

All commands accept: `--json`, `--quiet`, `--verbose`, `--dry-run`

- Use `--json` for machine-parseable output (recommended for agent use)
- Use `--dry-run` to preview actions without side effects
- Use `--quiet` to suppress non-error output

## Backend Configuration

Backends are configured in `.blobsy.yml`:

```yaml
backends:
  default:
    url: s3://bucket/prefix/    # S3
    url: local:../blob-store    # Local directory
    type: command               # Custom commands
```

Override in CI: `export BLOBSY_BACKEND_URL=s3://bucket/prefix/`

## Key Concepts

- `.yref` files are YAML pointers committed to Git (hash, size, remote_key)
- Content-addressable: identical files share the same blob
- SHA-256 integrity verification on push and pull
- Compression (zstd/gzip/brotli) configured per-repo
- Externalization rules control which files get tracked in directory scans

## Common Agent Workflows

### Track and push new files

```bash
blobsy track data/model.bin
blobsy push
git add data/model.bin.yref
git commit -m "Track model.bin"
```

### Pull files after clone

```bash
blobsy pull
blobsy verify
```

### Check repository health

```bash
blobsy doctor --json
blobsy status --json
```
