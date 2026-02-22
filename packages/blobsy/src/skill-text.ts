/**
 * Embedded documentation text for `blobsy skill` and `blobsy prime` commands.
 *
 * Provides self-documentation for AI agents to discover blobsy capabilities
 * without needing to read external files.
 */

export const SKILL_BRIEF = `\
blobsy: Git-native large file storage CLI.
Track large files with .yref pointers in Git, store blobs in S3/local/custom backends.

Commands: init, track, push, pull, sync, status, verify, untrack, rm, mv, config, health, doctor
Global flags: --json, --quiet, --verbose, --dry-run

Quick start:
  blobsy init s3://bucket/prefix/
  blobsy track <file>
  blobsy push
  blobsy pull
`;

export const SKILL_FULL = `\
# blobsy

Git-native large file storage CLI.
Track large files with .yref pointer files in Git while storing blobs in S3, local
directories, or custom command backends.

## Commands

  blobsy init <url>          Initialize with backend URL (s3://, local:, etc.)
  blobsy track <path...>     Track files or directories (creates .yref pointers)
  blobsy untrack <path...>   Stop tracking (keeps local files)
  blobsy push [path...]      Upload local blobs to the configured backend
  blobsy pull [path...]      Download blobs from the configured backend
  blobsy sync [path...]      Bidirectional push + pull
  blobsy status [path...]    Show sync state of tracked files
  blobsy verify [path...]    Verify file integrity (SHA-256)
  blobsy rm <path...>        Remove tracked files
  blobsy mv <src> <dest>     Move/rename tracked files
  blobsy config [key] [val]  Show, get, or set .blobsy.yml values
  blobsy health              Test backend connectivity
  blobsy doctor [--fix]      Run diagnostics, optionally auto-fix
  blobsy hooks <action>      Install/uninstall pre-commit hook

## Global Options

  --json       Machine-readable JSON output (recommended for agents)
  --quiet      Suppress non-error output
  --verbose    Detailed progress output
  --dry-run    Preview actions without side effects

## Configuration

Backends configured in .blobsy.yml:

  backends:
    default:
      url: s3://bucket/prefix/     # S3 or S3-compatible
      url: local:../blob-store     # Local filesystem
      type: command                 # Custom shell commands

Override via environment: BLOBSY_BACKEND_URL=s3://bucket/prefix/

## Key Concepts

- .yref files are YAML pointers committed to Git (format, hash, size, remote_key)
- Content-addressable: identical files share the same blob (SHA-256)
- Compression: zstd, gzip, or brotli (configurable per-repo)
- Externalization rules control which files are tracked in directory scans
## Common Workflows

Track and push:
  blobsy track data/model.bin
  blobsy push
  git add data/model.bin.yref && git commit -m "Track model"

Pull after clone:
  blobsy pull
  blobsy verify

Check health:
  blobsy doctor --json
  blobsy status --json
`;

export const PRIME_TEXT = `\
# blobsy context

## What is blobsy?

A standalone CLI for storing large files outside Git while tracking them with
lightweight .yref pointer files. No special server required -- works with S3,
local directories, or custom command backends.

## Current state

Run these to assess the repo:
  blobsy status --json    # See tracked files and their sync state
  blobsy doctor --json    # Check for issues
  blobsy config           # View current configuration

## Architecture

- .yref pointer files (YAML) are committed to Git
- Original files are added to .gitignore
- Blobs stored in content-addressable remote storage (SHA-256)
- Backends: AwsCliBackend (default for S3), BuiltinS3Backend (SDK fallback), LocalBackend, CommandBackend (all implement Backend interface)
- Transfer coordinator handles compression, key generation, backend dispatch

## File layout

  .blobsy.yml              Config (backends, compression, externalization rules)
  data/file.bin.yref       Pointer file for data/file.bin
  data/.gitignore          Auto-managed: gitignores tracked files
  .blobsy/stat-cache/      Local cache for fast change detection
  .blobsy/trash/           Untracked .yref files (recoverable)

## Useful commands

  blobsy status --json     # Machine-readable file states
  blobsy push --dry-run    # Preview what would be uploaded
  blobsy pull --dry-run    # Preview what would be downloaded
  blobsy doctor --fix      # Auto-repair common issues
  blobsy verify            # SHA-256 integrity check
`;
