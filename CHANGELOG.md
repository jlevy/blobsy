# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core CLI: init, track, untrack, rm, mv, push, pull, sync, status, verify, config,
  health, doctor, hooks, check-unpushed, pre-push-check
- `blobsy setup --auto <url>`: One-command setup (wraps init + hooks + agent
  integration)
- `blobsy add <path...>`: Track files and stage changes to git (recommended workflow)
- `blobsy readme`: Display the project README in the terminal
- `blobsy docs [topic]`: Display user documentation with section navigation (`--list`,
  `--brief`)
- `--min-size` flag on `track` and `add`: Override minimum file size for directory
  tracking (e.g. `--min-size 100kb`)
- Config command enhancements (git-style multi-level configuration):
  - `--global` flag: Read/write user-global config (~/.blobsy.yml), works outside git
    repos
  - `--show-origin` flag: Show which config file each value comes from
    (builtin/global/repo/subdir)
  - `--unset` flag: Remove config keys with automatic fallback to other scopes
  - Config precedence: subdir .blobsy.yml → repo root .blobsy.yml → global ~/.blobsy.yml
    → builtin defaults
  - Smart path formatting: displays ~/.blobsy.yml with tilde, repo files as relative
    paths
- Git hooks (installed by default, opt-out with `--no-hooks`):
  - Pre-commit: Verifies staged `.bref` files match their local file hashes
  - Pre-push: Auto-runs `blobsy push` to upload unpushed blobs before git push
  - Lefthook/husky detection with manual integration guidance
- S3 backend with SHA-256 checksums, atomic downloads, and custom endpoint support
- Local filesystem backend
- Custom command backend with shell-free execution model
- Content-addressable storage with SHA-256 integrity
- Compression support: zstd, gzip, brotli (configurable per-repo)
- Externalization rules for directory scanning
- Stat cache for fast change detection
- Global options: `--json`, `--quiet`, `--verbose`, `--dry-run`
- Agent skill commands: `blobsy skill`
- Agent integration via `blobsy setup --auto` (installs `.claude/skills/blobsy/SKILL.md`
  and `AGENTS.md` section)
- Self-documenting `.bref` pointer files with comment header
- S3 key sanitization for safe remote key generation
- Doctor command with did-you-mean suggestions for unknown config keys

### Changed

- Default `externalize.always` list is now empty (previously included `*.parquet`,
  `*.bin`, etc.). Externalization now relies on `min_size` (default 1MB) only.
  Users can still configure `always` patterns in `.blobsy.yml`.
- Colored help output: styled commands, options, and section headers via picocolors
- `showHelpAfterError()` provides help hints on unknown commands or missing arguments

### Fixed

- Directory tracking now respects `config.ignore` patterns (previously walked into
  `node_modules/`, `dist/`, and other ignored directories)
