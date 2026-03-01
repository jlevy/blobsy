# blobsy — Quick Reference

**blobsy** tracks large files with `.bref` pointers in Git, storing blobs in S3 or local
backends.

## Key Concepts

- `.bref` files are lightweight pointers committed to Git
- Blobs (actual file data) live in remote storage
- SHA-256 content-addressable: identical files = same blob
- Config in `.blobsy.yml` with hierarchical override (repo root → subdirectory)

## Essential Commands

```
blobsy setup --auto <url>   Set up blobsy (s3://..., local:...)
blobsy add <path>           Track + stage to git (recommended)
blobsy track <path>         Track without staging
blobsy push                 Upload blobs to remote
blobsy pull                 Download blobs from remote
blobsy status               Show sync state
blobsy verify               Check file integrity
```

## Externalization Rules (directory tracking)

1. `never` patterns → stays in git (highest priority)
2. `always` patterns → externalized regardless of size
3. `min_size` (default: 200kb) → files >= threshold externalized

Override threshold: `blobsy track --min-size 100kb data/`

## Configuration

```yaml
# .blobsy.yml
backends:
  default:
    url: s3://my-bucket/blobs/
externalize:
  min_size: 200kb
  always: ["*.parquet"]
compress:
  algorithm: zstd
```

## Quick Workflow

```bash
blobsy setup --auto s3://bucket/prefix/
blobsy add data/
git commit -m "Track large files"
git push
```

For full documentation: `blobsy docs`
