# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core CLI: init, track, untrack, rm, mv, push, pull, sync, status, verify, config,
  health, doctor, hooks, check-unpushed, pre-push-check
- S3 backend with SHA-256 checksums, atomic downloads, and custom endpoint support
- Local filesystem backend
- Custom command backend with shell-free execution model
- Content-addressable storage with SHA-256 integrity
- Compression support: zstd, gzip, brotli (configurable per-repo)
- Externalization rules for directory scanning
- Stat cache for fast change detection
- Global options: `--json`, `--quiet`, `--verbose`, `--dry-run`
- Pre-commit hook integration (direct install + lefthook/husky detection)
- Agent skill commands: `blobsy skill`, `blobsy prime`
- Self-documenting `.bref` pointer files with comment header
- S3 key sanitization for safe remote key generation
