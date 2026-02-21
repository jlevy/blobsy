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

Common flags across commands: `--json`, `--quiet`, `--verbose`, `--help`. Mutating
commands add `--dry-run`. Commands with conflict/destructive overrides add `--force`.

Exit codes: 0 = success, 1 = error, 2 = conflict

## Core Modules

| Module | Responsibility |
| --- | --- |
| `cli.ts` | Commander.js entry point, all subcommand registration |
| `types.ts` | YRef, BlobsyConfig, StatCacheEntry, FileState types |
| `ref.ts` | Parse/serialize `.yref` files (YAML with comment header, stable key ordering) |
| `config.ts` | Parse/merge `.blobsy.yml` hierarchy, apply built-in defaults |
| `hash.ts` | SHA-256 streaming hashing, format as `sha256:<64-hex>` |
| `paths.ts` | Path resolution (file, `.yref`, directory), repo-root detection |
| `gitignore.ts` | Add/remove entries in blobsy-managed block, per-directory |
| `stat-cache.ts` | Per-file stat cache (file-per-entry, atomic writes, three-way merge) |
| `backend-local.ts` | Local filesystem backend (copy files to/from a directory) |
| `backend-command.ts` | Command template backend (shell out with variable substitution) |
| `transfer.ts` | Transfer coordinator (concurrency pool, per-file push/pull) |
| `template.ts` | Key template evaluation (`{iso_date_secs}`, `{content_sha256}`, etc.) |
| `compress.ts` | Compression via `node:zlib` (zstd, gzip, brotli) |
| `externalize.ts` | Externalization rules (size threshold, always/never patterns) |
| `format.ts` | Human-readable output formatting (state symbols, sizes, tables) |

## Implementation Plan

### Phase 1: Foundation + Offline Commands

Build the core primitives and all commands that work without a backend.

**Core primitives:**

- [ ] CLI scaffold with Commander.js: all subcommands registered with `--help`
- [ ] `types.ts`: YRef, BlobsyConfig, FileState, StatCacheEntry
- [ ] `ref.ts`: Parse/serialize `.yref` files
- [ ] `config.ts`: Parse `.blobsy.yml`, merge hierarchy, apply defaults
- [ ] `hash.ts`: SHA-256 streaming hash
- [ ] `paths.ts`: Path resolution (file path, `.yref` path, directory expansion)
- [ ] `gitignore.ts`: Manage blobsy-managed block in `.gitignore`
- [ ] `externalize.ts`: Apply externalization rules for directory tracking
- [ ] `template.ts`: Key template evaluation
- [ ] `format.ts`: State symbols, human-readable sizes, output formatting

**Commands:**

- [ ] `blobsy --help` (top-level and per-command)
- [ ] `blobsy init` (create `.blobsy.yml`, install hooks)
- [ ] `blobsy track` (single file, directory, idempotent re-track)
- [ ] `blobsy status` (all state symbols, summary, actions needed)
- [ ] `blobsy verify` (hash every file, report ok/mismatch/missing)
- [ ] `blobsy untrack` (move to trash, update gitignore)
- [ ] `blobsy rm` (delete local, move ref to trash, `--local` variant)
- [ ] `blobsy mv` (move payload + ref, update gitignore)
- [ ] `blobsy config` (get/set values)

**Unit tests:**

- [ ] `ref-parser.test.ts`: Parse, serialize, round-trip, reject malformed
- [ ] `config.test.ts`: Parse, merge hierarchy, defaults, invalid config
- [ ] `hash.test.ts`: Known content hash, empty file, format
- [ ] `gitignore.test.ts`: Add, remove, duplicate prevention, create new
- [ ] `path-resolution.test.ts`: File, `.yref`, directory, relative/absolute

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

### Phase 2: Backend + Sync Commands

Wire up the local and echo backends.
Implement push, pull, sync, and all supporting commands.

**Core modules:**

- [ ] `stat-cache.ts`: Per-file stat cache with three-way merge
- [ ] `backend-local.ts`: Local filesystem backend
- [ ] `backend-command.ts`: Command template backend (echo backend)
- [ ] `transfer.ts`: Transfer coordinator with concurrency pool
- [ ] `compress.ts`: Compression via `node:zlib`

**Commands:**

- [ ] `blobsy push` (upload, verify hash, set remote_key, warn uncommitted)
- [ ] `blobsy pull` (download, atomic write, refuse if modified)
- [ ] `blobsy sync` (health check, three-way merge, conflict detection)
- [ ] `blobsy health` (backend connectivity check)
- [ ] `blobsy hooks install|uninstall` (manage pre-commit hook)
- [ ] `blobsy hook pre-commit` (internal: auto-push on commit)
- [ ] `blobsy doctor` (diagnostics, `--fix`)
- [ ] `blobsy check-unpushed` (find refs with missing blobs)
- [ ] `blobsy pre-push-check` (CI-friendly verification)

**Unit tests:**

- [ ] `stat-cache.test.ts`: Read/write/delete entries, cached hash, merge base, GC

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
- [ ] `json/status-json.tryscript.md`
- [ ] `json/verify-json.tryscript.md`
- [ ] `json/push-pull-json.tryscript.md`
- [ ] `json/sync-json.tryscript.md`
- [ ] `json/doctor-json.tryscript.md`

### Phase 3: Polish + Cloud Backend Prep

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
| `status.tryscript.md` | `blobsy status` | All 7 state symbols (circle/half/check/tilde/question/deleted), summary, actions, empty repo |
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
| `auth-errors.tryscript.md` | Missing/invalid credentials (Phase 3) |
| `permission-errors.tryscript.md` | Missing write/read permissions (Phase 3) |
| `network-errors.tryscript.md` | Timeout, DNS failure (Phase 3) |

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

4. **Compression in Phase 2 vs Phase 3:** Resolved: Phase 2, alongside sync commands.
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
