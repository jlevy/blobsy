# Blobsy Agent Skill

Git-native large file storage CLI. Track large files with `.bref` pointers in Git while
storing blobs in S3, local directories, or custom backends.

## Installation

If blobsy is not installed, run:

```bash
npm install -g blobsy@latest
blobsy setup --auto s3://bucket/prefix/
```

## When to Use

Use blobsy when:

- A repository contains large binary files (models, datasets, media, archives)
- Files need to be shared across machines without committing them to Git
- You need content-addressable, deduplicated blob storage
- The user mentions: blobsy, large files, blob storage, .bref, bref, externalize, Git
  LFS alternative

## Quick Reference

```bash
blobsy track <path...>     # Track files (creates .bref pointers)
blobsy push [path...]      # Upload blobs to backend
blobsy pull [path...]      # Download blobs from backend
blobsy status --json       # Current state (JSON)
blobsy doctor --json       # Health check (JSON)
```

## Current State

For dynamic info, use:

- `blobsy status --json` - Tracked files, sync state
- `blobsy doctor --json` - Configuration, health, issues

All commands accept: `--json`, `--quiet`, `--verbose`, `--dry-run`
