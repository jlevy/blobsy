# Feature: Blobsy Phase 1 Implementation

**Date:** 2026-02-21

**Author:** Joshua Levy

**Status:** Draft

## Overview

Phase 1: end-to-end scaffolding, CLI, testing infrastructure, and all core commands and
libraries with a local backend.
This is the foundation that everything else builds on.

This plan covers the complete CLI with all subcommands, using TDD with golden session
testing (tryscript) against the local file-based backend and echo backend.
The approach is to build the full system end-to-end so that cloud backends (S3, R2,
etc.) can be dropped in later with minimal changes.

## Goals

- Implement all V1 CLI commands as specified in the design doc
- Full golden test coverage for every subcommand and workflow
- Local backend and echo backend for testing (no cloud credentials needed)
- All core modules: ref parsing, config, hashing, stat cache, gitignore management, path
  resolution, transfer coordination
- TDD workflow: write golden tests first, then implement until they pass

## Non-Goals

- Cloud backends (S3, R2, GCS, Azure) -- deferred; local backend exercises all code
  paths
- Garbage collection (`blobsy gc`) -- deferred to V2
- Branch-isolated storage (`{git_branch}` template variable) -- deferred
- `blobsy stats` aggregate command -- deferred
- Transfer engine abstraction / batch transfers -- deferred
- Export/import -- deferred

## Background

The design is fully specified in:

- [blobsy-design.md](../../design/current/blobsy-design.md) -- core design
- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) -- testing
  strategy
- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
  -- backend types and transport
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md) --
  stat cache
- [blobsy-implementation-notes.md](../../design/current/blobsy-implementation-notes.md)
  -- code snippets and hook architecture

The codebase is scaffolded: monorepo with `packages/blobsy/`, build/lint/test tooling
configured, placeholder source in `src/index.ts`. No CLI implementation yet.

## Complete Command Inventory

Every command that must be implemented for V1, with key behaviors:

### Setup Commands

| Command | Key Behaviors |
| --- | --- |
| `blobsy init <url>` | Create `.blobsy.yml` from URL positional arg (e.g. `s3://bucket/prefix/`, `./remote`) plus optional flags (`--region`, `--endpoint`). Install pre-commit hook. Fully non-interactive: fails with usage error if URL missing on first run. Unrecognized URL schemes rejected with clear error. Idempotent (subsequent runs skip config, install hooks only). |
| `blobsy config [key] [value]` | Get/set configuration values. Show current backend when called as `blobsy config backend`. |
| `blobsy health` | Check transport backend health (credentials, connectivity). Fail fast with clear error. |
| `blobsy hooks install\|uninstall` | Manage pre-commit hook. Detect hook managers (Lefthook, Husky, pre-commit). Idempotent. |

### Tracking Commands

| Command | Key Behaviors |
| --- | --- |
| `blobsy track <path>...` | Create `.yref`, add to `.gitignore`. Single file = always externalize. Directory = apply externalization rules. Idempotent (re-track updates hash). |
| `blobsy untrack [--recursive] <path>` | Move `.yref` to `.blobsy/trash/`, remove from `.gitignore`. Keep local file. Require `--recursive` for directories. |
| `blobsy rm [--local\|--recursive] <path>` | Move `.yref` to trash, remove from `.gitignore`, delete local file. `--local` keeps `.yref` and remote. |
| `blobsy mv <source> <dest>` | Move payload + `.yref`, update `.gitignore`. Preserve `remote_key`. Files only (no directories). |

### Sync Commands

| Command | Key Behaviors |
| --- | --- |
| `blobsy push [path...]` | Upload to remote, set `remote_key` in `.yref`. Verify hash before upload. `--force` to override. Warn on uncommitted refs. |
| `blobsy pull [path...]` | Download from remote. Refuse if local modified (exit 2). `--force` to overwrite. Atomic writes (temp+rename). |
| `blobsy sync [path...]` | Bidirectional: health check, then per-file three-way merge via stat cache. Push modified, pull updated refs. Detect conflicts. |

### Status & Verification Commands

| Command | Key Behaviors |
| --- | --- |
| `blobsy status [path...]` | Offline. Show state symbols (circle/half/check/tilde/question/deleted). Compare working tree vs HEAD. Summary + actions needed. |
| `blobsy verify [path...]` | Read and hash every file (bypass stat cache). Report ok/mismatch/missing. Exit 1 on any issue. |
| `blobsy check-unpushed` | Find committed `.yref` files with no `remote_key` or missing remote blobs. Use git blame for attribution. |
| `blobsy pre-push-check` | CI-friendly: verify all `.yref` files in HEAD have remote blobs. Exit 0 or 1. |

### Diagnostic Commands

| Command | Key Behaviors |
| --- | --- |
| `blobsy doctor` | Configuration, repository state, integrity checks. Detect missing `.gitignore` entries, orphaned entries, invalid `.yref` files. `--fix` for safe repairs. |

### Internal Commands

| Command | Key Behaviors |
| --- | --- |
| `blobsy hook pre-commit` | Find staged `.yref` files, push blobs, re-stage updated refs. Direct function call (no subprocess). |

### Global Flags

Common flags across commands: `--json`, `--verbose`, `--help`, `--force`. `--json` is
implemented from Stage 1. `--dry-run` (mutating commands) and `--quiet` are deferred to
Stage 3.

Exit codes: 0 = success, 1 = error, 2 = conflict

## Core Modules

| Module | Stage | Responsibility |
| --- | --- | --- |
| `cli.ts` | 1 | Commander.js entry point, all subcommand registration |
| `types.ts` | 1 | YRef, BlobsyConfig, StatCacheEntry, FileState types |
| `ref.ts` | 1 | Parse/serialize `.yref` files (YAML with comment header, stable key ordering) |
| `config.ts` | 1 | Parse/merge `.blobsy.yml` hierarchy, apply built-in defaults |
| `backend-url.ts` | 1 | Parse backend URLs (`s3://`, `gs://`, `azure://`, `local:`) into typed config |
| `hash.ts` | 1 | SHA-256 streaming hashing, format as `sha256:<64-hex>` |
| `paths.ts` | 1 | Path resolution (file, `.yref`, directory), repo-root detection |
| `gitignore.ts` | 1 | Add/remove entries in blobsy-managed block, per-directory |
| `externalize.ts` | 1 | Externalization rules (size threshold, always/never patterns) |
| `format.ts` | 1 | Human-readable output formatting (state symbols, sizes, tables) |
| `stat-cache.ts` | 2 | Per-file stat cache (file-per-entry, atomic writes, three-way merge) |
| `backend-local.ts` | 2 | Local filesystem backend (copy files to/from a directory) |
| `backend-command.ts` | 2 | Command template backend (shell out with variable substitution) |
| `transfer.ts` | 2 | Transfer coordinator (concurrency pool, per-file push/pull) |
| `template.ts` | 2 | Key template evaluation (`{iso_date_secs}`, `{content_sha256}`, etc.) |
| `compress.ts` | 2 | Compression via `node:zlib` (zstd, gzip, brotli) |
| `doctor.ts` | 2 | Diagnostic checks, integrity validation, `--fix` repairs |
| `hooks.ts` | 2 | Pre-commit hook install/uninstall, hook manager detection |

### Stage 1 Modules

#### `cli.ts` -- CLI Entry Point

**Responsibility:** Commander.js entry point. Registers all subcommands, parses global
flags, dispatches to per-command handlers, manages exit codes, and formats output (human
or JSON).

**Key exports:**

- `main()` -- parse argv and dispatch.
- Per-command handlers (e.g. `handleInit`, `handleTrack`, `handleStatus`, etc.).
- `hookPreCommit()` -- internal command invoked by the pre-commit shim.

**Depends on:** All other modules (dispatches to each).

**Design constraints:**

- Fully non-interactive. Missing required args produce usage errors with examples, never
  prompts.
- Global options: `--json`, `--verbose`, `--help`, `--force`. (`--dry-run` and `--quiet`
  deferred to Stage 3.)
- Exit codes: 0 = success, 1 = error, 2 = conflict.
- Path specifications: accept original file path (`data/model.bin`), `.yref` path
  (`data/model.bin.yref`), or directory path. Normalize by stripping `.yref` suffix.
- `blobsy track <file>` always externalizes; `blobsy track <dir>` applies externalization
  rules per-file.
- `blobsy track` is idempotent (updates hash if changed, no-op if unchanged).
- `blobsy push` verifies local hash matches `.yref` hash before upload. `--force`
  overrides.
- `blobsy pull` refuses if local file modified (exit 2). `--force` overrides.
- `blobsy untrack` and `blobsy rm` on directories require `--recursive`.
- `blobsy mv`: files only in initial release, always preserves `remote_key`.
- `blobsy sync` runs health check first (skippable with `--skip-health-check`).
- JSON output wraps all responses in `{ "schema_version": "0.1", ... }`.
- Follow tbd's CLI patterns: `BaseCommand` class, `CommandContext` for global options,
  `OutputManager` for dual-mode output, `CLIError` hierarchy, `picocolors` for terminal
  colors, colored help via Commander v14+ `configureHelp()`.

#### `types.ts` -- Shared Type Definitions

**Responsibility:** Central type definitions shared across the codebase. No runtime logic.

**Key exports:**

```typescript
interface YRef {
  format: string              // "blobsy-yref/0.1"
  hash: string                // "sha256:<64-char-lowercase-hex>"
  size: number                // bytes
  remote_key?: string         // evaluated template key (absent until first push)
  compressed?: string         // "zstd" | "gzip" | "brotli" (absent if uncompressed)
  compressed_size?: number    // bytes (absent if uncompressed)
}

interface StatCacheEntry {
  path: string
  hash: string                // "sha256:..."
  size: number
  mtimeNs: string | null      // BigInt serialized as string
  mtimeMs: number
  cachedAt: number            // epoch ms
}

interface BackendConfig {
  type: "s3" | "gcs" | "azure" | "local" | "command"
  url?: string
  bucket?: string
  prefix?: string
  path?: string               // for local
  region?: string
  endpoint?: string
  push_command?: string        // for command backends
  pull_command?: string
}

interface BlobsyConfig {
  backend?: string
  backends?: Record<string, BackendConfig>
  externalize?: ExternalizeConfig
  compress?: CompressConfig
  ignore?: string[]
  remote?: { key_template: string }
  sync?: { tools: string[]; parallel: number }
  checksum?: { algorithm: string }
}

interface ExternalizeConfig {
  min_size: string | number   // "1mb" or bytes
  always: string[]
  never: string[]
}

interface CompressConfig {
  min_size: string | number
  algorithm: "zstd" | "gzip" | "brotli" | "none"
  always: string[]
  never: string[]
}

type FileStateSymbol = "○" | "◐" | "◑" | "✓" | "~" | "?" | "⊗"

type SyncAction =
  | { action: "up_to_date" }
  | { action: "pull"; remoteKey: string }
  | { action: "push"; newHash: string }
  | { action: "conflict"; localHash: string; remoteHash: string; baseHash: string }
  | { action: "error"; reason: string }

type ErrorCategory =
  | "authentication" | "not_found" | "network"
  | "permission" | "quota" | "storage_full" | "unknown"
```

**Depends on:** Nothing (pure types).

**Design constraints:**

- `YRef` fields use stable key ordering: `format`, `hash`, `size`, `remote_key`,
  `compressed`, `compressed_size`.
- `hash` format: `sha256:<64-char-lowercase-hex>`.
- `remote_key` does NOT include bucket or global prefix. Full remote path is
  `{bucket}/{global_prefix}/{remote_key}`.
- Format versioning: reject if major version unsupported; warn if minor is newer.

#### `ref.ts` -- `.yref` File I/O

**Responsibility:** Read and write `.yref` files. Serialize/deserialize YAML with
self-documenting comment header and stable field ordering.

**Key exports:**

- `readYRef(path: string): Promise<YRef>` -- parse, validate format version.
- `writeYRef(path: string, ref: YRef): Promise<void>` -- write with comment header, stable
  ordering, atomic (temp+rename).
- `validateFormatVersion(format: string): void` -- reject unsupported major, warn newer
  minor.

**Depends on:** `types.ts`, `yaml` npm package.

**Design constraints:**

- Comment header is always `# blobsy -- https://github.com/jlevy/blobsy\n\n`.
- Fields written in stable order: `format`, `hash`, `size`, `remote_key`, `compressed`,
  `compressed_size`. Omit absent optional fields.
- Atomic writes via temp-file-then-rename.
- Tolerate unknown extra fields on read (forward compatibility).
- `.yref` example:

```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
size: 15728640
remote_key: sha256/7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f
```

#### `config.ts` -- Configuration Loading

**Responsibility:** Load, merge, and validate hierarchical `.blobsy.yml` configuration.
Five levels: built-in defaults, `~/.blobsy.yml`, repo root, subdirectory, deeper
subdirectory. Bottom-up resolution.

**Key exports:**

- `resolveConfig(targetPath: string, repoRoot: string): Promise<BlobsyConfig>` -- walk up
  from target, merge bottom-up.
- `loadConfigFile(filePath: string): Promise<BlobsyConfig>` -- parse single file.
- `getBuiltinDefaults(): BlobsyConfig` -- hardcoded defaults.
- `mergeConfigs(base: BlobsyConfig, override: Partial<BlobsyConfig>): BlobsyConfig` --
  shallow merge (override replaces entire keys, no deep-merge).

**Depends on:** `types.ts`, `paths.ts`, `yaml` npm package.

**Design constraints:**

- Merge semantics: entire value replaced, not deep-merged. If a subdirectory specifies
  `externalize.always: ["*.parquet"]`, it completely replaces the parent's `always` list.
- Settings affecting remote storage (compression, checksum, `key_template`) must be in
  git-tracked config, not user-global.
- Hardcoded defaults (compiled into blobsy):
  - `externalize.min_size`: `"1mb"`
  - `externalize.always`: `["*.parquet", "*.bin", "*.weights", "*.onnx",
    "*.safetensors", "*.pkl", "*.pt", "*.h5", "*.arrow", "*.sqlite", "*.db"]`
  - `compress.algorithm`: `"zstd"`, `compress.min_size`: `"100kb"`
  - `remote.key_template`:
    `"{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"`
  - `sync.tools`: `["aws-cli", "rclone"]`, `sync.parallel`: `8`
  - `checksum.algorithm`: `"sha256"`
  - Full ignore and compress pattern lists as specified in the design doc.

#### `backend-url.ts` -- Backend URL Parsing

**Responsibility:** Parse backend URLs into structured config. Validate per-scheme rules.
Reject unrecognized schemes with helpful errors listing supported options.

**Key exports:**

- `parseBackendUrl(url: string): ParsedBackendUrl` -- parse and validate.
- `validateBackendUrl(parsed: ParsedBackendUrl, repoRoot: string): void` -- runtime checks
  (local path outside repo, etc.).
- `formatBackendUrl(parsed: ParsedBackendUrl): string` -- canonical display string.

**Depends on:** `paths.ts`.

**Design constraints:**

- Supported schemes: `s3://bucket/prefix/`, `gs://bucket/prefix/`,
  `azure://container/prefix/`, `local:path`.
- Cloud schemes require a non-empty prefix (reject `s3://my-bucket` alone).
- S3 bucket naming: 3-63 chars, lowercase alphanumeric + hyphens, no leading/trailing
  hyphen.
- Prefix must not start with `/`, must not contain `//`, `\`, null bytes, or control chars.
  Trailing slash normalized (always appended internally).
- `local:` paths resolved relative to repo root, not CWD. Must resolve outside repo.
  Tilde expansion supported.
- Bare paths rejected with hint: `Did you mean 'local:../blobsy-remote'?`
- Query strings and fragments rejected.
- Case-insensitive scheme matching.
- Error messages list all supported schemes with examples.

#### `hash.ts` -- Content Hashing

**Responsibility:** Compute SHA-256 hashes of file content via streaming. Format as
`sha256:<64-char-lowercase-hex>`.

**Key exports:**

- `computeHash(filePath: string): Promise<string>` -- stream file through SHA-256, return
  formatted hash.
- `hashString(input: string): string` -- hash a string (used by stat cache path
  computation).

**Depends on:** `node:crypto`, `node:fs`.

**Design constraints:**

- Hash is always of the **original file content** (before compression). This lets
  `blobsy status` verify integrity without decompression.
- Throughput ~400-600 MB/s; negligible overhead relative to network transfer.
- Deterministic: same content always produces same hash.

#### `paths.ts` -- Path Resolution

**Responsibility:** Resolve and normalize paths: repo root detection, `.yref` suffix
stripping/appending, POSIX normalization, stat cache path computation.

**Key exports:**

- `findRepoRoot(): Promise<string>` -- walk up to find `.git/` directory.
- `toRepoRelative(absolutePath: string, repoRoot: string): string`.
- `stripYrefExtension(path: string): string` -- `data/model.bin.yref` ->
  `data/model.bin`.
- `yrefPath(filePath: string): string` -- `data/model.bin` -> `data/model.bin.yref`.
- `normalizePath(path: string): string` -- POSIX forward slashes, no trailing slash for
  files.
- `getCacheEntryPath(cacheDir: string, relativePath: string): string` -- SHA-256 prefix
  sharding for stat cache.

**Depends on:** `node:path`, `node:crypto`.

**Design constraints:**

- All path variables in remote keys (`{repo_path}`, `{dirname}`) use POSIX forward slashes
  regardless of OS. Windows backslashes converted.
- Both `data/model.bin` and `data/model.bin.yref` accepted as input; produce identical
  behavior.
- Stat cache path: SHA-256 of repo-relative path, first 18 hex chars, 2-char prefix
  sharding (256 buckets). Example:

```typescript
function getCacheEntryPath(cacheDir: string, relativePath: string): string {
  const hash = createHash("sha256").update(relativePath).digest("hex").substring(0, 18)
  const prefix = hash.substring(0, 2)
  return join(cacheDir, prefix, `${hash}.json`)
}
```

#### `gitignore.ts` -- Gitignore Management

**Responsibility:** Add and remove entries within a clearly marked blobsy-managed block in
per-directory `.gitignore` files.

**Key exports:**

- `addGitignoreEntry(directory: string, relativeName: string): Promise<void>`.
- `removeGitignoreEntry(directory: string, relativeName: string): Promise<void>`.
- `readBlobsyBlock(gitignorePath: string): Promise<string[]>` -- parse managed entries.
- `writeBlobsyBlock(gitignorePath: string, entries: string[]): Promise<void>` -- rewrite
  block (sorted, deduped).

**Depends on:** `node:fs/promises`, `paths.ts`.

**Design constraints:**

- Managed block format:

```gitignore
# >>> blobsy-managed (do not edit) >>>
bigfile.zip
raw/data.parquet
# <<< blobsy-managed <<<
```

- Entries are paths relative to the `.gitignore` file's directory (not repo-relative).
- Entries sorted for minimal git diff noise.
- If no `.gitignore` exists in the target directory, create one.
- No wildcards, no negation patterns -- explicit per-file entries only.
- `.yref` files are NOT gitignored (only data files are).
- Preserve any non-blobsy content in the `.gitignore` (only modify the managed block).

#### `externalize.ts` -- Externalization Rules

**Responsibility:** Decide per-file whether to externalize (`.yref` + gitignore) or leave
in git, based on config rules.

**Key exports:**

- `shouldExternalize(filePath: string, fileSize: number, config: ExternalizeConfig): boolean`.
- `filterFilesForExternalization(files: Array<{path: string; size: number}>, config: ExternalizeConfig, ignorePatterns: string[]): Array<{path: string; externalize: boolean}>`.

**Depends on:** `types.ts`. Glob matching library (e.g. `picomatch`) for pattern matching.

**Design constraints:**

- **Explicit file** (`blobsy track data/bigfile.zip`): always externalizes, bypasses rules.
  The caller (`cli.ts`) handles this distinction.
- **Directory** (`blobsy track data/research/`): applies rules per-file.
- Decision logic order: (1) skip files matching `ignore` patterns, (2) check `never`
  patterns -- if match, keep in git, (3) check `always` patterns -- if match, externalize,
  (4) compare file size against `min_size`.
- Same `.gitignore`-style glob syntax for patterns.
- Subdirectory config override replaces the parent's pattern lists entirely (not appended).

#### `format.ts` -- Output Formatting

**Responsibility:** Format all CLI output: state symbols, file sizes, status tables,
transfer summaries, error messages with troubleshooting, and JSON envelopes.

**Key exports:**

- `formatFileState(symbol: FileStateSymbol, path: string, details: string): string`.
- `formatSize(bytes: number): string` -- human-readable (B, KB, MB, GB).
- `formatTransferSummary(results: TransferResult[]): string`.
- `formatError(error: BlobsyError): string` -- with troubleshooting suggestions.
- `formatJson(data: unknown): string` -- wrap in `{ "schema_version": "0.1", ... }`.
- `formatStatusOutput(files: FileStatus[]): string` -- full status table with summary and
  actions.

**Depends on:** `types.ts`.

**Design constraints:**

- State symbols: `○` (new), `◐` (committed not synced), `◑` (synced not committed),
  `✓` (fully done), `~` (modified), `?` (missing), `⊗` (staged for deletion).
- JSON output always includes `"schema_version": "0.1"`.
- Simple commands (track, mv) use `{ "message": "...", "level": "info" }`.
- Structured commands (status, verify, push/pull, doctor) use richer per-command schemas.
- Errors always use `{ "error": "...", "type": "..." }`.
- Error messages include: failed command, exit code, stdout+stderr, error category,
  troubleshooting suggestions.
- Partial failure: show both succeeded and failed files; aggregate summary at end.

### Stage 2 Modules

#### `stat-cache.ts` -- Stat Cache

**Responsibility:** File-per-entry stat cache at `.blobsy/stat-cache/` (gitignored,
machine-local). Provides fast change detection (avoid re-hashing unchanged files) and the
merge base for three-way conflict detection during sync.

**Key exports:**

- `readCacheEntry(cacheDir: string, relativePath: string): Promise<StatCacheEntry | null>`.
- `writeCacheEntry(cacheDir: string, entry: StatCacheEntry): Promise<void>` -- atomic
  writes.
- `deleteCacheEntry(cacheDir: string, relativePath: string): Promise<void>`.
- `getCachedHash(cacheDir: string, relativePath: string, currentStats: FileStats): Promise<string | null>`
  -- returns hash only if size+mtime match (fast path).
- `getMergeBase(cacheDir: string, relativePath: string): Promise<string | null>` -- returns
  cached hash regardless of stat (for three-way merge).
- `gcCache(cacheDir: string, trackedFiles: Set<string>): Promise<number>`.

**Depends on:** `node:fs/promises`, `paths.ts` (for `getCacheEntryPath`), `types.ts`.

**Design constraints:**

- Stat comparison: composite key is `size` + `mtimeNs`. Fall back to `size` + `mtimeMs`
  when nanosecond unavailable.
- `mtimeNs` stored as string (JSON does not support BigInt). Uses
  `fs.stat(path, { bigint: true })` for nanosecond precision.
- Cache is mandatory for `track`, `push`, `pull`, `sync`; optional for `status`, `verify`.
- Never update cache without completing the corresponding operation. If push fails
  mid-upload, retain old entry.
- Directory layout: 2-char prefix sharding, 18-hex-char filename, `.json` extension.
- Tolerant of corrupt entries (skip on read, overwrite on next write).
- Three-way merge decision table:

| Local hash | .yref hash | Cache hash | Action |
| --- | --- | --- | --- |
| A | A | A | Up to date |
| A | A | (none) | Create cache entry |
| A | B | A | Pull (git pull updated .yref) |
| B | A | A | Push (user modified file) |
| B | B | A | Up to date (both changed same way) |
| B | C | A | **Conflict** (both changed differently) |
| B | A | (none) | **Error** (ambiguous, no merge base) |

#### `backend-local.ts` -- Local Backend

**Responsibility:** Implement the `local` backend: directory-to-directory file copy for
dev/testing. Same interface as cloud backends.

**Key exports:**

- `localPush(localPath: string, remoteDir: string, remoteKey: string): Promise<void>`.
- `localPull(remoteDir: string, remoteKey: string, localPath: string): Promise<void>`.
- `localBlobExists(remoteDir: string, remoteKey: string): Promise<boolean>`.
- `localHealthCheck(remoteDir: string): Promise<void>` -- verify directory exists and is
  writable.

**Depends on:** `node:fs/promises`, `paths.ts`, `hash.ts`.

**Design constraints:**

- Health check: verify target directory exists and is writable (create temp file, write,
  delete).
- Atomic downloads: write to `.blobsy-tmp-*` temp file, verify SHA-256, rename to final
  location.
- Target directory created by first push if it does not exist.
- Local backend path must resolve outside the git repository (validated by
  `backend-url.ts` at init time).
- No credentials needed; filesystem permissions only.
- Uses the same error categorization as cloud backends (permission denied maps to
  `permission`, path not found maps to `not_found`, disk full maps to `storage_full`).

#### `backend-command.ts` -- Command Template Backend

**Responsibility:** Implement the `command` backend: execute arbitrary shell commands for
push/pull with template variable expansion. Used by the echo backend test fixture.

**Key exports:**

- `commandPush(pushCommand: string, vars: CommandTemplateVars): Promise<void>`.
- `commandPull(pullCommand: string, vars: CommandTemplateVars): Promise<void>`.
- `expandCommandTemplate(template: string, vars: CommandTemplateVars): string`.

**Depends on:** `node:child_process`, `types.ts`, `format.ts`.

**Design constraints:**

- Template variables: `{local}` (absolute local path), `{remote}` (full remote key),
  `{relative_path}` (repo-relative), `{bucket}`.
- One command invocation per file, up to `sync.parallel` concurrently.
- On pull: blobsy sets `$BLOBSY_TEMP_OUT` env var pointing to temp file. User template
  writes there. Blobsy verifies hash and renames on exit 0.
- Capture both stdout and stderr. Display both on failure.
- Exit code 0 = success; non-zero = failure with categorized error.
- Security: command backends from repo-level `.blobsy.yml` require explicit trust
  (`blobsy trust`). Only allowed from `~/.blobsy.yml` or trusted repos.
- Uses POSIX `/bin/sh` on Unix, `cmd.exe` on Windows.

#### `transfer.ts` -- Transfer Coordinator

**Responsibility:** Orchestrate file transfers: select transfer tool, manage concurrency
pool, delegate to the appropriate backend, handle compression before/after, manage atomic
writes on pull.

**Key exports:**

- `pushFile(filePath: string, ref: YRef, config: BlobsyConfig): Promise<TransferResult>`.
- `pullFile(ref: YRef, localPath: string, config: BlobsyConfig): Promise<TransferResult>`.
- `syncFiles(files: FileInfo[], config: BlobsyConfig): Promise<SyncResult>`.
- `selectTransferTool(tools: string[]): Promise<string>` -- capability check (binary
  exists, credentials valid, endpoint reachable).
- `runHealthCheck(config: BlobsyConfig): Promise<void>`.

**Depends on:** `backend-local.ts`, `backend-command.ts`, `compress.ts`, `hash.ts`,
`config.ts`, `template.ts`, `stat-cache.ts`, `format.ts`.

**Design constraints:**

- Push workflow: compress to temp (if applicable) -> upload -> clean up temp.
- Pull workflow: download to `.blobsy-tmp-*` -> decompress (if compressed) -> verify hash
  -> atomic rename to final path.
- Concurrency: up to `sync.parallel` (default 8) concurrent transfers.
- Tool selection: capability check, not just binary existence. Falls through to next tool
  in the `sync.tools` preference list on failure.
- Health check runs before bulk transfers. Cached for 60 seconds.
- Partial failure: continue remaining files, collect all errors, exit code 1 if any failed.
- Blobsy manages atomic downloads for ALL backends (never relies on external tools for
  atomicity).
- Error categorization: pattern-match on stdout/stderr for auth, network, permission,
  not_found, quota, storage_full.

#### `template.ts` -- Key Template Evaluation

**Responsibility:** Evaluate remote key templates to compute where blobs are stored.
Called during `push` to set `remote_key` in `.yref`.

**Key exports:**

- `evaluateTemplate(template: string, vars: TemplateVars): string`.
- `getCompressSuffix(algorithm: string | undefined): string` -- `.zst`, `.gz`, `.br`, or
  `""`.

**Depends on:** `paths.ts`, `hash.ts`.

**Design constraints:**

- Template variables:

| Variable | Example |
| --- | --- |
| `{iso_date_secs}` | `20260220T140322Z` (format: `YYYYMMDDTHHMMSSZ`, no punctuation) |
| `{content_sha256}` | Full 64-char hex hash |
| `{content_sha256_short}` | First 12 hex chars (48 bits entropy) |
| `{repo_path}` | `data/research/model.bin` |
| `{filename}` | `model.bin` |
| `{dirname}` | `data/research/` |
| `{compress_suffix}` | `.zst`, `.gz`, `.br`, or empty string |
| `{git_branch}` | **Deferred** |

- Text outside `{...}` is literal.
- All path variables use POSIX forward slashes regardless of OS.
- Default template:
  `"{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"`.
- Template must be consistent across all users (committed in `.blobsy.yml`).

#### `compress.ts` -- Compression

**Responsibility:** Compress and decompress files using Node.js built-in `node:zlib`
(zstd, gzip, brotli). Decide per-file whether to compress based on config rules.

**Key exports:**

- `shouldCompress(filePath: string, fileSize: number, config: CompressConfig): boolean`.
- `compressFile(inputPath: string, outputPath: string, algorithm: string): Promise<void>`
  -- streaming.
- `decompressFile(inputPath: string, outputPath: string, algorithm: string): Promise<void>`
  -- streaming.
- `getCompressSuffix(algorithm: string): string`.

**Depends on:** `node:zlib`, `node:fs`, `types.ts`.

**Design constraints:**

- Decision logic mirrors externalize: (1) check `never` patterns, (2) check `always`
  patterns, (3) compare against `min_size`.
- Algorithms: `zstd` (default), `gzip`, `brotli`, `none`.
- Minimum Node.js 22.11.0 for zstd.
- Streaming in-process; no external CLI tools.
- Hash is always of the original content (not compressed).
- `.yref` records compression: `compressed: zstd`, `compressed_size: 4194304`.
- Compression skip list must be in repo-level config (affects remote keys).
- Default never-compress: `*.gz`, `*.zst`, `*.zip`, `*.tar.*`, `*.parquet`, `*.png`,
  `*.jpg`, `*.jpeg`, `*.mp4`, `*.webp`, `*.avif`.
- Default always-compress: `*.json`, `*.csv`, `*.tsv`, `*.txt`, `*.jsonl`, `*.xml`,
  `*.sql`.
- Default min_size: `"100kb"`.

#### `doctor.ts` -- Diagnostics

**Responsibility:** Comprehensive diagnostic and health check. Validates configuration,
connectivity, repository state, integrity, and git hooks. Auto-fix mode for safe repairs.

**Key exports:**

- `runDoctor(options: DoctorOptions): Promise<DoctorResult>`.
- `checkConfiguration(config: BlobsyConfig): DiagnosticResult`.
- `checkRepositoryState(repoRoot: string): Promise<DiagnosticResult>`.
- `checkGitHooks(repoRoot: string): DiagnosticResult`.
- `checkConnectivity(config: BlobsyConfig): Promise<DiagnosticResult>`.
- `checkIntegrity(repoRoot: string): Promise<DiagnosticResult>`.
- `autoFix(repoRoot: string, issues: DiagnosticIssue[]): Promise<FixResult>`.

**Depends on:** `config.ts`, `ref.ts`, `stat-cache.ts`, `gitignore.ts`, `transfer.ts`,
`hooks.ts`, `paths.ts`, `format.ts`.

**Design constraints:**

- Exit codes: 0 = all passed, 1 = warnings (functional but suboptimal), 2 = errors
  (action required).
- Output sections: CONFIGURATION, REPOSITORY STATE, GIT HOOKS, CONNECTIVITY, INTEGRITY
  CHECKS.
- Detects: missing `.gitignore` entries, orphaned `.gitignore` entries, invalid `.yref`
  files (malformed YAML, unsupported format), uncommitted refs after push, modified files
  not re-tracked, stale stat cache entries, missing pre-commit hook.
- `--fix` safe repairs: add missing `.gitignore` entries, remove orphaned entries, clean
  stale stat cache, install missing hook, remove orphaned `.blobsy-tmp-*` temp files.
- Connectivity check: test upload/download (write + delete 1 KB test object).

#### `hooks.ts` -- Git Hook Management

**Responsibility:** Install and uninstall the pre-commit hook shim script. Detect existing
hook managers and provide integration guidance.

**Key exports:**

- `installHook(repoRoot: string): Promise<void>`.
- `uninstallHook(repoRoot: string): Promise<void>`.
- `isHookInstalled(repoRoot: string): boolean`.
- `detectHookManager(repoRoot: string): string | null` -- check for Lefthook, Husky,
  pre-commit framework.

**Depends on:** `node:fs/promises`, `paths.ts`.

**Design constraints:**

- Shim script content:

```sh
#!/bin/sh
# Installed by: blobsy hooks install
# To bypass: git commit --no-verify
exec blobsy hook pre-commit
```

- Uses `#!/bin/sh` (POSIX), not bash. `exec` for correct exit code propagation.
- Hook manager detection before install:
  1. `lefthook.yml` -> print Lefthook integration instructions.
  2. `.husky/` -> print Husky integration instructions.
  3. `.pre-commit-config.yaml` -> print pre-commit framework instructions.
  4. Existing non-blobsy hook -> warn and offer to append.
  5. Otherwise, install standalone shim.
- Uninstall only removes hooks containing `Installed by: blobsy` marker.
- `chmod +x` on install.
- Idempotent: re-running overwrites with latest shim version.

## Implementation Plan

Implementation is broken into three stages within this plan.

### Stage 1: Foundation + Offline Commands

Build the core primitives and all commands that work without a backend.

**Core primitives:**

- [ ] CLI scaffold with Commander.js: all subcommands registered with `--help`
- [ ] `types.ts`: YRef, BlobsyConfig, FileState, StatCacheEntry
- [ ] `ref.ts`: Parse/serialize `.yref` files
- [ ] `config.ts`: Parse `.blobsy.yml`, merge hierarchy, apply defaults
- [ ] `backend-url.ts`: Parse backend URLs (`s3://`, `local:`, etc.) into config
- [ ] `hash.ts`: SHA-256 streaming hash
- [ ] `paths.ts`: Path resolution (file path, `.yref` path, directory expansion)
- [ ] `gitignore.ts`: Manage blobsy-managed block in `.gitignore`
- [ ] `externalize.ts`: Apply externalization rules for directory tracking
- [ ] `format.ts`: State symbols, human-readable sizes, output formatting

**Commands:**

- [ ] `blobsy --help` (top-level and per-command)
- [ ] `blobsy init` (create `.blobsy.yml`, install stub pre-commit hook -- hook exits 0
  until `push` is implemented in Stage 2)
- [ ] `blobsy track` (single file, directory, idempotent re-track)
- [ ] `blobsy status` (offline state symbols: `○` `◐` `~` `?` `⊗`; summary and actions.
  Symbols requiring push -- `◑` and `✓` -- are exercised in Stage 2 golden tests.)
- [ ] `blobsy verify` (hash every file, report ok/mismatch/missing)
- [ ] `blobsy untrack` (move to trash, update gitignore)
- [ ] `blobsy rm` (delete local, move ref to trash, `--local` variant)
- [ ] `blobsy mv` (move payload + ref, update gitignore)
- [ ] `blobsy config` (get/set values)

**Note:** `--json` is implemented for all commands from Stage 1. `--dry-run` and
`--quiet` are deferred to Stage 3.

**Unit tests:**

- [ ] `ref-parser.test.ts`: Parse, serialize, round-trip, reject malformed
- [ ] `config.test.ts`: Parse, merge hierarchy, defaults, invalid config
- [ ] `backend-url.test.ts`: Parse `s3://`, `gs://`, `azure://`, `local:`, reject invalid
- [ ] `hash.test.ts`: Known content hash, empty file, format
- [ ] `gitignore.test.ts`: Add, remove, duplicate prevention, create new
- [ ] `path-resolution.test.ts`: File, `.yref`, directory, relative/absolute
- [ ] `externalize.test.ts`: Size threshold, always/never patterns, edge cases

**Golden tests (tryscript):**

- [ ] `commands/help.tryscript.md`
- [ ] `commands/init.tryscript.md`
- [ ] `commands/track.tryscript.md`
- [ ] `commands/status.tryscript.md`
- [ ] `commands/verify.tryscript.md`
- [ ] `commands/untrack.tryscript.md`
- [ ] `commands/rm.tryscript.md`
- [ ] `commands/mv.tryscript.md`
- [ ] `commands/config.tryscript.md`

### Stage 2: Backend + Sync Commands

Wire up the local and echo backends.
Implement push, pull, sync, and all supporting commands.

**Core modules:**

- [ ] `stat-cache.ts`: Per-file stat cache with three-way merge
- [ ] `backend-local.ts`: Local filesystem backend
- [ ] `backend-command.ts`: Command template backend (shell out with variable substitution)
- [ ] `transfer.ts`: Transfer coordinator with concurrency pool
- [ ] `template.ts`: Key template evaluation (`{iso_date_secs}`, `{content_sha256}`, etc.)
- [ ] `compress.ts`: Compression via `node:zlib`

**Commands:**

- [ ] `blobsy push` (upload, verify hash, set remote_key, warn uncommitted)
- [ ] `blobsy pull` (download, atomic write, refuse if modified)
- [ ] `blobsy sync` (health check, three-way merge, conflict detection)
- [ ] `blobsy health` (backend connectivity check)
- [ ] `blobsy hooks install|uninstall` (manage pre-commit hook; replaces stub from Stage 1)
- [ ] `blobsy hook pre-commit` (internal: auto-push on commit)
- [ ] `blobsy doctor` (diagnostics, `--fix`)
- [ ] `blobsy check-unpushed` (find refs with missing blobs)
- [ ] `blobsy pre-push-check` (CI-friendly verification)

**Unit tests:**

- [ ] `stat-cache.test.ts`: Read/write/delete entries, cached hash, merge base, GC
- [ ] `template.test.ts`: Variable substitution, all template variables, edge cases

**Golden tests (tryscript):**

- [ ] `commands/push-pull.tryscript.md`
- [ ] `commands/sync.tryscript.md`
- [ ] `commands/doctor.tryscript.md`
- [ ] `commands/hooks.tryscript.md`
- [ ] `commands/health.tryscript.md`
- [ ] `commands/check-unpushed.tryscript.md`
- [ ] `commands/pre-push-check.tryscript.md`
- [ ] `echo-backend/push-commands.tryscript.md`
- [ ] `echo-backend/pull-commands.tryscript.md`
- [ ] `echo-backend/sync-commands.tryscript.md`
- [ ] `echo-backend/compression-commands.tryscript.md`
- [ ] `workflows/fresh-setup.tryscript.md`
- [ ] `workflows/modify-and-resync.tryscript.md`
- [ ] `workflows/two-user-conflict.tryscript.md`
- [ ] `workflows/doctor-fix.tryscript.md`
- [ ] `workflows/compression.tryscript.md`
- [ ] `workflows/branch-workflow.tryscript.md`
- [ ] `workflows/multi-file-sync.tryscript.md`
- [ ] `errors/conflict-errors.tryscript.md`
- [ ] `errors/validation-errors.tryscript.md`
- [ ] `errors/partial-failure.tryscript.md`
- [ ] `errors/not-found-errors.tryscript.md`
- [ ] `json/status-json.tryscript.md` (full JSON shape including `◑` and `✓` states)
- [ ] `json/verify-json.tryscript.md`
- [ ] `json/push-pull-json.tryscript.md`
- [ ] `json/sync-json.tryscript.md`
- [ ] `json/doctor-json.tryscript.md`

### Stage 3: Polish + Cloud Backend Prep

Harden edge cases, finalize error messages, prepare the backend interface for cloud
backends.

- [ ] Error message quality pass (all errors follow the checklist from testing design)
- [ ] `--dry-run` support across all mutating commands
- [ ] `--quiet` support across all commands
- [ ] Backend interface formalized for easy S3/R2 addition
- [ ] `errors/auth-errors.tryscript.md` (S3 credential errors)
- [ ] `errors/permission-errors.tryscript.md`
- [ ] `errors/network-errors.tryscript.md`
- [ ] `publint` validation passes
- [ ] README with usage examples
- [ ] npm package ready for publishing

## Golden Test Inventory

Every subcommand mapped to its tryscript test file(s). Tests are organized by category.

### Per-Command Tests (`tests/golden/commands/`)

| Test File | Command(s) | Key Scenarios |
| --- | --- | --- |
| `help.tryscript.md` | `blobsy --help`, `blobsy <cmd> --help` | Top-level help, per-command help for all commands |
| `init.tryscript.md` | `blobsy init` | First run (creates config), subsequent run (idempotent), with flags |
| `track.tryscript.md` | `blobsy track` | Single file, directory, idempotent no-op, re-track after modify, filesystem inspection |
| `status.tryscript.md` | `blobsy status` | Offline symbols (`○` `◐` `~` `?` `⊗`), summary, actions, empty repo. Synced symbols (`◑` `✓`) tested in `json/status-json.tryscript.md` (Stage 2). |
| `verify.tryscript.md` | `blobsy verify` | All match, mismatch, missing, single file |
| `push-pull.tryscript.md` | `blobsy push`, `blobsy pull` | Single file, all files, already synced, after delete, uncommitted warning, force |
| `sync.tryscript.md` | `blobsy sync` | Up-to-date, push needed, pull needed, conflict, health check |
| `untrack.tryscript.md` | `blobsy untrack` | Single file, directory (requires --recursive), verify trash |
| `rm.tryscript.md` | `blobsy rm` | Default (delete local), `--local`, `--recursive`, verify trash |
| `mv.tryscript.md` | `blobsy mv` | File rename, verify payload + ref + gitignore moved |
| `config.tryscript.md` | `blobsy config` | Show all, get key, set key |
| `doctor.tryscript.md` | `blobsy doctor` | Healthy repo, missing gitignore, orphaned entries, `--fix` |
| `hooks.tryscript.md` | `blobsy hooks` | Install, uninstall, detect hook managers |
| `health.tryscript.md` | `blobsy health` | Local backend reachable, unreachable |
| `check-unpushed.tryscript.md` | `blobsy check-unpushed` | Clean repo, refs without remote_key |
| `pre-push-check.tryscript.md` | `blobsy pre-push-check` | All refs have blobs, some missing |

### Workflow Tests (`tests/golden/workflows/`)

| Test File | Scenario |
| --- | --- |
| `fresh-setup.tryscript.md` | Init -> track -> push -> clone -> pull -> verify |
| `modify-and-resync.tryscript.md` | Modify tracked file -> re-track -> push -> verify |
| `two-user-conflict.tryscript.md` | Concurrent modification, stat cache conflict detection |
| `doctor-fix.tryscript.md` | Break things, doctor detects, `--fix` repairs |
| `compression.tryscript.md` | Track + push with zstd compression, pull + decompress |
| `branch-workflow.tryscript.md` | Feature branch -> merge -> sync (no post-merge gap) |
| `multi-file-sync.tryscript.md` | Many files, concurrent push/pull |

### Echo Backend Tests (`tests/golden/echo-backend/`)

| Test File | What It Verifies |
| --- | --- |
| `push-commands.tryscript.md` | Exact push command construction visible in output |
| `pull-commands.tryscript.md` | Exact pull command construction visible in output |
| `sync-commands.tryscript.md` | Sync issues correct push/pull calls |
| `compression-commands.tryscript.md` | Compression temp file handling visible |

### Error Tests (`tests/golden/errors/`)

| Test File | Error Category |
| --- | --- |
| `conflict-errors.tryscript.md` | Pull refuses modified, push refuses hash mismatch, sync conflict |
| `validation-errors.tryscript.md` | Malformed `.yref`, bad config, unsupported format version |
| `partial-failure.tryscript.md` | Some files succeed, some fail (permission denied) |
| `not-found-errors.tryscript.md` | Missing blob in remote, missing `.yref` |
| `auth-errors.tryscript.md` | Missing/invalid credentials (Stage 3) |
| `permission-errors.tryscript.md` | Missing write/read permissions (Stage 3) |
| `network-errors.tryscript.md` | Timeout, DNS failure (Stage 3) |

### JSON Output Tests (`tests/golden/json/`)

| Test File | What It Captures |
| --- | --- |
| `status-json.tryscript.md` | Full JSON shape for `blobsy status --json` |
| `verify-json.tryscript.md` | Full JSON shape for `blobsy verify --json` |
| `push-pull-json.tryscript.md` | Full JSON shape for `blobsy push/pull --json` |
| `sync-json.tryscript.md` | Full JSON shape for `blobsy sync --json` |
| `doctor-json.tryscript.md` | Full JSON shape for `blobsy doctor --json` |

## Testing Strategy

### TDD Flow

1. Write the golden test (expected CLI output) for a command
2. Run `tryscript run` -- it fails (command not implemented)
3. Implement the command until the golden test passes
4. Run `tryscript run --update` to capture actual output if minor formatting differs
5. Review the diff, adjust test or implementation
6. Commit both the implementation and the golden test

### Two-Layer Testing

- **Unit tests (vitest)**: Core logic -- ref parsing, config merge, hashing, stat cache,
  gitignore management, path resolution
- **Golden tests (tryscript)**: CLI behavior -- every command’s output, filesystem side
  effects, error messages, JSON shapes

### Backend Strategy

- **Local backend** (`local:../path`): Full end-to-end testing.
  Files actually copied.
- **Echo backend** (`type: command` + `fixtures/echo-backend.ts`): A small TypeScript
  script that mirrors the aws-cli interface (`push`, `pull`, `exists` subcommands).
  Echoes the exact operation to stdout, then performs a local copy to `.mock-remote/`.
  This gives golden tests transport-layer visibility without fragile bash one-liners.
- **Cloud backends**: Not needed for V1 implementation.
  Local backend exercises all code paths identically.

### Coverage

```bash
vitest run --coverage
tryscript run --coverage --merge-lcov coverage/lcov.info tests/golden/
```

## Resolved Questions

1. **tryscript availability:** Resolved.
   tryscript is published and added as a devDependency.
   Run `npx tryscript@latest docs` to confirm API details for sandbox mode, fixtures,
   patterns, and coverage merging.

2. **Commander.js vs alternatives:** Resolved: Commander.js.
   Well-established, used by tbd as a reference implementation.
   Follow tbd’s CLI patterns: BaseCommand class, CommandContext for global options,
   OutputManager for dual-mode output (text + JSON), CLIError hierarchy, picocolors for
   terminal colors, colored help via Commander v14+ `configureHelp()`. See `attic/tbd/`
   for source reference.

3. **`blobsy init` interactivity:** Resolved: fully non-interactive.
   Backend specified as a URL positional argument (e.g. `s3://bucket/prefix/`,
   `./remote`). Additional params via flags (`--region`, `--endpoint`). Missing URL on
   first run produces a usage error with examples (not a prompt).
   Unrecognized URL schemes are rejected with a clear error listing supported schemes.
   This is agent-friendly, testable via tryscript, and produces clear audit trails.

4. **Compression in Stage 2 vs Stage 3:** Resolved: Stage 2, alongside sync commands.
   Compression is integral to push/pull and should be built and tested together.

5. **Pre-commit hook testing:** Resolved: use a local git repo harness within golden
   tests. The tryscript sandbox initializes a local git repo, so golden tests can run
   `git init`, `git add`, `git commit`, `git clone` (local path), etc.
   with no network. Golden tests should use `git init -b main` and set `user.name` and
   `user.email` so commit metadata and branch names are deterministic.
   The workflow tests (`fresh-setup.tryscript.md`, `branch-workflow.tryscript.md`, etc.)
   exercise the full hook flow using real local git operations.

6. **Stat cache nanosecond mtime:** Resolved: use `fs.stat(path, { bigint: true })` to
   get `mtimeNs` (BigInt, nanosecond precision).
   This is stable API in Node.js 22+. Validated on macOS APFS: real sub-millisecond
   differentiation (two sequential writes differ by ~500ns). Linux ext4/btrfs store
   nanosecond precision on disk.
   Store `mtimeNs` as string in stat cache YAML (BigInt serialized).
   For comparison, always use `mtimeNs` -- no fallback needed since `bigint: true`
   always returns it. On filesystems without nanosecond support (FAT32, older HFS+), the
   sub-ms digits are zeros, which is harmless for change detection.

7. **Error message format for backends:** Resolved: implement the full structured error
   format from the start.
   The local backend is a genuine backend, not a special case.
   It uses the same error categorization, same error types, same `--json` error shapes
   as any cloud backend.
   Each backend type has its own parameters (local has `path`, S3 has `bucket`/`region`,
   etc.) but the error interface is uniform.
   Local backend errors (permission denied, disk full, path not found) map to the same
   categories as S3 errors (access denied, quota exceeded, key not found).

8. **`blobsy health` for local backend:** Resolved: health check for a local backend
   verifies the directory exists and is writable (create a temp file, write, delete).
   Same structured health response as cloud backends -- just different checks.

9. **Config file placement for `blobsy init`:** Resolved: lazy directory creation.
   `blobsy init` only creates `.blobsy.yml` (and installs the hook).
   The `.blobsy/` directory (stat cache, trash, etc.)
   is created on demand when a command first needs to write a file there.
   All file writes create parent directories atomically at write time via a shared
   utility. This keeps `init` minimal and avoids complexity around directory lifecycle.

10. **`--json` for all commands:** Resolved: all commands support `--json`. For commands
    without a rich structured output (like `blobsy track`, `blobsy mv`), use a simple
    schema: `{ "message": "...", "level": "info" | "debug" | "warning" }`. Commands with
    structured data (status, verify, push/pull, doctor) use their own richer schemas.
    Errors always use `{ "error": "...", "type": "..." }`. JSON payloads include
    `schema_version` for forward-compatible parsing.

## Open Questions

(All resolved.)

## References

- [blobsy-design.md](../../design/current/blobsy-design.md)
- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md)
- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md)
- [blobsy-implementation-notes.md](../../design/current/blobsy-implementation-notes.md)
