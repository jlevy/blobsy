# Feature: Blobsy Phase 2 -- V1 Completion

**Date:** 2026-02-21

**Author:** Joshua Levy

**Status:** Complete (all stages implemented)

## Overview

Phase 2 completes the full Blobsy V1: S3 backend integration, CLI polish (`--dry-run`,
error quality), agent skill integration, comprehensive documentation, MinIO-based e2e
testing, and npm publishing readiness.

Phase 1 delivered all CLI commands and core modules with local/echo backends and full
golden test coverage.
Phase 2 takes this working system and makes it production-ready with real cloud
backends, polished UX, agent-friendly documentation, and a publishable npm package.

## Goals

- S3 backend working end-to-end (push/pull/sync/health) with `@aws-sdk/client-s3`
- `--dry-run` global flag across all mutating commands
- Error message quality pass (full checklist from testing design)
- Agent skill integration: `blobsy skill`, `blobsy prime`, SKILL.md, CURSOR.mdc
- Complete CLI documentation: README, troubleshooting guide, `--help` quality pass
- End-to-end testing against MinIO (S3-compatible, Docker-based)
- npm package publishable and `publint`-clean
- `blobsy trust` command for command backend security

## Non-Goals

- Garbage collection (`blobsy gc`) -- deferred to V2
- Branch-isolated storage (`{git_branch}` template variable) -- deferred
- `blobsy stats` aggregate command -- deferred
- Transfer engine abstraction / batch transfers -- deferred
- Export/import (`blobsy export` / `blobsy import`) -- deferred
- Azure backend (`azure://`) -- deferred (S3-compatible covers most cases via
  `--endpoint`)
- Dictionary compression -- deferred
- Sub-file delta sync -- deferred
- Remote staleness detection via provider hashes -- deferred
- Multi-backend routing -- deferred
- Parallel `.yref` directory option -- deferred

## Background

Phase 1
([plan-2026-02-21-blobsy-phase1-implementation.md](plan-2026-02-21-blobsy-phase1-implementation.md))
delivered:

- All V1 CLI commands implemented and tested
- All core modules: ref parsing, config, hashing, stat cache, gitignore, paths,
  externalization, compression, template evaluation, transfer coordination
- Local backend and echo backend (command backend) working end-to-end
- 116 unit tests passing, 36 golden tests covering all commands, workflows, errors, and
  JSON output shapes
- Stage 1 (foundation + offline commands) and Stage 2 (backend + sync commands) fully
  complete
- Stage 3 (polish + cloud backend prep) moved to this Phase 2 plan

The codebase is a solid foundation.
All code paths exercise identically via the local backend.
Phase 2 drops in cloud backends, polishes the UX, adds documentation, and prepares for
publishing.

### Design References

- [blobsy-design.md](../../design/current/blobsy-design.md) -- core design
- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
  -- backend types, transport delegation, error handling
- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) -- testing
  strategy
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md) --
  stat cache
- [blobsy-implementation-notes.md](../../design/current/blobsy-implementation-notes.md)
  -- code snippets, hook architecture

### Guidelines Applied

- `tbd guidelines typescript-cli-tool-rules` -- Commander.js patterns, picocolors,
  `--dry-run`/`--quiet`/`--verbose`, colored help
- `tbd guidelines cli-agent-skill-patterns` -- SKILL.md, prime/skill commands,
  progressive disclosure, self-documenting help, agent integration files

## Bead Mapping

| Stage | Epic Bead | Sub-beads |
| --- | --- | --- |
| Stage 1: CLI Polish | `blobsy-nwrr` | `blobsy-t6db` (--dry-run), `blobsy-1jcr` (--quiet validation), `blobsy-kz4d` (error quality), `blobsy-f2of` (golden tests) |
| Stage 2: S3 Backend + Trust | `blobsy-8yrt` | `blobsy-32uo` (Backend interface), `blobsy-lkpe` (backend-s3.ts), `blobsy-n8i8` (trust), `blobsy-zqhx` (unit tests), `blobsy-ay6g` (error golden tests) |
| Stage 3: E2E Testing + CI | `blobsy-os74` | `blobsy-ecok` (MinIO e2e), `blobsy-00fu` (CI config) |
| Stage 4: Documentation | `blobsy-40s0` | `blobsy-j6iz` (README), `blobsy-bpzg` (CLI help), `blobsy-4jht` (skill commands), `blobsy-p5mb` (agent files), `blobsy-rdtm` (troubleshooting), `blobsy-qte5` (.yref self-doc) |
| Stage 5: Publishing | `blobsy-4qu2` | `blobsy-dtzy` (doc sync), `blobsy-cfyt` (package readiness), `blobsy-ackj` (CI/CD), `blobsy-hdi5` (deps audit) |

Also open: `blobsy-u4cs` (branch name sanitization, Phase 2 scope).

## Implementation Plan

### Stage 1: CLI Polish

Complete the deferred polish items from Phase 1 Stage 3. These are prerequisites for
everything else because they affect the interface that documentation and tests depend
on.

#### `--dry-run` Support

- [ ] Add `--dry-run` global option to Commander.js program
- [ ] `CommandContext` includes `dryRun` boolean
- [ ] Mutating commands (`track`, `untrack`, `rm`, `mv`, `push`, `pull`, `sync`,
  `hooks install/uninstall`, `doctor --fix`) check `dryRun` and print what would happen
  without executing
- [ ] Dry-run output format: `Would track data/model.bin`, `Would push 3 files`, etc.
- [ ] JSON dry-run output: `{ "dry_run": true, "actions": [...] }`

#### `--quiet` Support

`--quiet` is already implemented in Phase 1 for all commands.

- [ ] Verify `--quiet` and `--json` are mutually exclusive (error if both specified)
- [ ] Add golden test for `--quiet` behavior

#### Error Message Quality Pass

- [ ] Audit all error messages against the checklist from
  [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md):
  - File path and size shown
  - Exact failed command shown (with variables expanded)
  - Full stdout+stderr from transport tool
  - Error category (authentication, network, permission, etc.)
  - Concrete troubleshooting suggestions
  - Works in both human and `--json` modes
- [ ] CLIError hierarchy: `BlobsyError` base class with `category`, `troubleshooting`,
  `exitCode` fields
- [ ] Error formatting uses `format.ts` consistently (no ad-hoc `console.error`)
- [ ] All error paths have JSON equivalents

#### Golden Tests for Polish

- [ ] `commands/dry-run.tryscript.md` -- `--dry-run` across track, push, pull, sync, rm,
  mv
- [ ] `commands/quiet.tryscript.md` -- `--quiet` suppresses output, errors still shown
- [ ] Update existing golden tests if output format changed

### Stage 2: S3 Backend + Trust

Implement the S3 backend using `@aws-sdk/client-s3` and the `blobsy trust` command.
Transfer tool delegation (aws-cli, rclone) is deferred to V1.1.

#### Backend Interface

- [ ] Define `Backend` interface:
  ```typescript
  interface Backend {
    push(localPath: string, remoteKey: string): Promise<void>
    pull(remoteKey: string, localPath: string): Promise<void>
    blobExists(remoteKey: string): Promise<boolean>
    healthCheck(): Promise<void>
    deleteBlob?(remoteKey: string): Promise<void>
  }
  ```
- [ ] Refactor `backend-local.ts` and `backend-command.ts` to implement `Backend`
- [ ] `resolveBackend(config: BlobsyConfig): Backend` factory function
- [ ] `BLOBSY_BACKEND_URL` env var override (checked before `.blobsy.yml`)

#### `backend-s3.ts` -- Built-in SDK

- [ ] S3 client initialization from `BackendConfig` (bucket, region, endpoint, prefix)
- [ ] `s3Push`: `PutObject` with SHA-256 checksum header (`x-amz-checksum-sha256`)
- [ ] `s3Pull`: `GetObject` to temp file, verify hash, atomic rename
- [ ] `s3BlobExists`: `HeadObject` (catch 404 -> false)
- [ ] `s3HealthCheck`: `HeadBucket` or `ListObjectsV2` (limit 1)
- [ ] `s3Delete`: `DeleteObject` (for health check cleanup)
- [ ] S3-compatible endpoint support (R2, MinIO, B2, Tigris) via custom endpoint config
- [ ] Error categorization: map SDK errors to `ErrorCategory` (`AccessDenied` ->
  `authentication`, `NoSuchBucket` -> `not_found`, etc.)
- [ ] Multipart upload for files > 100 MB (configurable threshold)

#### Transfer Tool Delegation (Deferred to V1.1)

V1 uses `@aws-sdk/client-s3` directly for all S3 transfers.
External tool delegation (aws-cli, rclone) is deferred to V1.1 to simplify V1 testing
and reduce the surface area.

#### GCS Backend (Deferred to V1.1)

GCS support is deferred to V1.1 to reduce V1 scope and dependencies.
URL parsing for `gs://` is already implemented in `backend-url.ts`.

#### `blobsy trust` Command

- [ ] `blobsy trust` marks the current repo as trusted for command backend execution
- [ ] Trust marker stored in `~/.blobsy/trusted-repos.json` (repo path -> trust
  timestamp)
- [ ] `blobsy trust --revoke` removes trust
- [ ] `blobsy trust --list` shows trusted repos
- [ ] Command backends from repo-level `.blobsy.yml` check trust before execution

#### Unit Tests

- [ ] `backend-s3.test.ts`: mock SDK calls, verify push/pull/exists/health/error
  categorization
- [ ] `trust.test.ts`: trust marker create/read/revoke, trust check before command
  execution

#### Golden Tests

- [ ] `errors/auth-errors.tryscript.md` -- S3 credential errors (simulated via env var
  clearing)
- [ ] `errors/permission-errors.tryscript.md` -- S3 access denied
- [ ] `errors/network-errors.tryscript.md` -- connection timeout, DNS failure

### Stage 3: End-to-End Cloud Testing

Real cloud backend integration tests, run in CI (nightly or on-demand, not every PR).

#### S3 Integration Tests (Deferred to V1.1)

Real-cloud S3 integration tests require credentials in CI. Deferred to V1.1 in favor of
MinIO-based e2e tests that provide equivalent coverage without cloud dependencies.

#### S3-Compatible Testing (MinIO)

- [ ] Docker-based MinIO for local S3-compatible testing
- [ ] `e2e/minio-push-pull.test.ts`: push/pull against MinIO
- [ ] Runs in CI on every PR (no cloud credentials needed)
- [ ] Docker compose or testcontainers setup

#### CI Configuration

- [ ] GitHub Actions workflow: `ci.yml` -- build + unit tests + golden tests on every PR
- [ ] GitHub Actions workflow: `e2e.yml` -- MinIO e2e tests on every PR
- [ ] Test matrix: Node.js 22 and 24
- [ ] Coverage: merge vitest + tryscript coverage, report in PR

### Stage 4: Documentation and Agent Integration

Complete documentation and agent skill integration following the patterns from
`tbd guidelines cli-agent-skill-patterns` and the tbd CLI source as reference.

#### README.md

- [ ] Project description and motivation (why blobsy exists, what gap it fills)
- [ ] Quick start: install, init, track, push, pull
- [ ] Complete command reference with examples
- [ ] Configuration reference (`.blobsy.yml` with all fields documented)
- [ ] Backend setup guides: S3, S3-compatible (R2, MinIO), GCS, local
- [ ] Template patterns explained (timestamp+hash, CAS, global shared)
- [ ] CI integration example (GitHub Actions, generic CI)
- [ ] Troubleshooting section (common errors with solutions)
- [ ] Comparison with Git LFS, DVC, rclone

#### CLI Help Quality Pass

- [ ] Every command `--help` has: description, usage line, arguments, options, examples
- [ ] Use Commander.js v14+ `configureHelp()` for colored help output
- [ ] Help epilog on top-level `blobsy --help`:
  ```
  GETTING STARTED
    blobsy init s3://my-bucket/prefix/ --region us-east-1
    blobsy track data/model.bin
    blobsy push

  For full context: blobsy prime
  Documentation: https://github.com/jlevy/blobsy
  ```
- [ ] Error messages reference relevant `--help` commands

#### Agent Skill Integration

Following `tbd guidelines cli-agent-skill-patterns`:

- [ ] `blobsy skill` command: output skill content to stdout
  - `blobsy skill` -- full skill (baseline)
  - `blobsy skill --brief` -- condensed version (~400 tokens)
- [ ] `blobsy prime` command: dashboard + status + workflow rules
  - Shows: version, initialization state, tracked file summary, backend health, quick
    reference
  - `blobsy prime --brief` -- condensed for constrained contexts
- [ ] `blobsy docs` command: output README content
- [ ] Tiered skill files bundled in `dist/docs/`:
  - `skill-baseline.md` (~2000 tokens) -- full workflow guide
  - `skill-brief.md` (~400 tokens) -- condensed version

#### Agent Integration Files

- [ ] `SKILL.md` for Claude Code (`.claude/skills/blobsy/SKILL.md`):
  - YAML frontmatter: name, description, allowed-tools
  - Two-part description: capabilities + “Use when …” triggers
  - Installation and quick start
  - Command reference table
  - Workflow examples for agents
- [ ] `CURSOR.mdc` for Cursor IDE (`.cursor/rules/blobsy.mdc`):
  - MDC frontmatter: description, alwaysApply
  - Context-appropriate rules for Cursor agent
- [ ] `AGENTS.md` section with HTML markers:
  - `<!-- BEGIN BLOBSY INTEGRATION -->` / `<!-- END BLOBSY INTEGRATION -->`
  - Workflow guide, command table, session protocol

#### Self-Documenting .yref Files

- [ ] Verify comment header: `# blobsy -- https://github.com/jlevy/blobsy`
- [ ] Verify `blobsy status` and `blobsy --help` referenced in header
- [ ] Agent encountering `.yref` for first time can learn system from header + npx

#### Troubleshooting Guide

- [ ] `docs/troubleshooting.md` covering:
  - Authentication errors (AWS, GCS)
  - Permission errors (IAM policies needed)
  - Network errors (proxy, firewall, timeout)
  - Common mistakes (forgot to push, forgot to commit, modified after track)
  - Push/commit coordination issues
  - Hook manager integration issues
  - Stat cache corruption recovery

### Stage 5: Publishing and Release

#### Design Document Sync Pass

Before release, reconcile all design documents with the actual implementation:

- [ ] `blobsy-design.md`: verify all examples, command summaries, and workflows match
  the implemented CLI
- [ ] `blobsy-backend-and-transport-design.md`: verify against implemented backends and
  transfer logic
- [ ] `blobsy-testing-design.md`: verify golden test examples match actual golden test
  output
- [ ] `blobsy-stat-cache-design.md`: verify against `stat-cache.ts` implementation
- [ ] `blobsy-implementation-notes.md`: verify code snippets are current
- [ ] Phase 1 spec: mark any remaining open items, add final status
- [ ] Phase 2 spec: mark all items complete or deferred with reason

#### Package Readiness

- [ ] `publint` validation passes
- [ ] `package.json` metadata: description, keywords, repository, homepage, license,
  engines, bin, files, exports
- [ ] `bin` entry points to compiled CLI (`dist/cli.mjs`)
- [ ] `npx blobsy --help` works (verify global install and npx paths)
- [ ] `pnpm pack` produces a clean tarball
- [ ] Verify: `npm install -g blobsy` installs and `blobsy --help` works
- [ ] Tree-shake: verify no dev dependencies in production bundle

#### CI/CD

- [ ] GitHub Actions: lint, typecheck, test, build on every PR
- [ ] GitHub Actions: npm publish on tag push (with provenance)
- [ ] GitHub Actions: MinIO e2e tests on every PR
- [ ] `CHANGELOG.md` or release notes convention

#### Dependencies Audit

- [ ] Review all runtime dependencies:
  - `commander` -- CLI parsing
  - `yaml` -- ref and config file parsing
  - `@aws-sdk/client-s3` -- S3 backend
  - `picocolors` -- terminal colors
  - `fast-glob` -- file discovery
- [ ] Verify no unnecessary dependencies

## Module Inventory for Phase 2

### New Modules

| Module | Stage | Responsibility |
| --- | --- | --- |
| `backend-s3.ts` | 2 | S3 backend via `@aws-sdk/client-s3` |
| `transfer-tool.ts` | V1.1 | External tool detection and delegation (aws-cli, rclone) |
| `backend.ts` | 2 | Backend interface and factory (`resolveBackend`) |
| `trust.ts` | 2 | Repo trust management for command backends |
| `skill.ts` | 4 | Skill/prime command content generation |

### Modified Modules

| Module | Stage | Changes |
| --- | --- | --- |
| `cli.ts` | 1 | Add `--dry-run` global flag; `trust`, `skill`, `prime`, `docs` commands |
| `transfer.ts` | 2 | Use `Backend` interface, integrate S3 SDK backend |
| `format.ts` | 1 | Error formatting improvements, dry-run output format |
| `types.ts` | 2 | `Backend` interface, `TransferTool` type |
| `config.ts` | 2 | `BLOBSY_BACKEND_URL` env var override |

## Testing Strategy

### Unit Tests (New)

| Test File | What It Covers |
| --- | --- |
| `backend-s3.test.ts` | S3 SDK operations (mocked), error categorization |
| `trust.test.ts` | Trust marker create/read/revoke |

### Golden Tests (New)

| Test File | What It Covers |
| --- | --- |
| `commands/dry-run.tryscript.md` | `--dry-run` across all mutating commands |
| `commands/quiet.tryscript.md` | `--quiet` suppresses output |
| `commands/trust.tryscript.md` | `blobsy trust` and command backend security |
| `errors/auth-errors.tryscript.md` | Missing/invalid credentials |
| `errors/permission-errors.tryscript.md` | Access denied errors |
| `errors/network-errors.tryscript.md` | Timeout, DNS, connection errors |

### E2E Tests (New)

| Test File | Backend | CI |
| --- | --- | --- |
| `e2e/minio-push-pull.test.ts` | MinIO (Docker) | Every PR |

### Coverage

```bash
pnpm test                                                 # unit tests
npx tryscript run tests/golden/                           # golden tests
npx tryscript run --coverage --merge-lcov coverage/lcov.info tests/golden/  # merged
```

## Documentation Inventory

All documentation that must exist for V1:

| Document | Location | Purpose |
| --- | --- | --- |
| README.md | repo root | Project overview, quick start, command reference |
| docs/troubleshooting.md | docs/ | Error resolution guide |
| SKILL.md | `.claude/skills/blobsy/` | Claude Code agent skill |
| CURSOR.mdc | `.cursor/rules/` | Cursor IDE agent rules |
| AGENTS.md section | repo root | Multi-agent integration |
| `--help` text | built-in | Per-command usage, examples |
| `.yref` comment header | built-in | Self-documenting ref files |
| skill-baseline.md | bundled in dist/ | Full skill for `blobsy skill` |
| skill-brief.md | bundled in dist/ | Brief skill for `blobsy skill --brief` |

## V1 Scope Boundary

The following lists clarify what is in V1 (this plan) vs.
deferred to V1.1+.

**V1 must-have:**

- S3 backend via `@aws-sdk/client-s3` (built-in SDK, no external tool delegation)
- Local and command backends (already implemented in Phase 1)
- `blobsy trust` command
- `--dry-run` support
- E2E tests against MinIO (Docker-based, no cloud credentials needed)
- Full documentation (README, CLI help, agent skill files)
- CI: build + unit + golden + MinIO e2e on every PR

**V1.1+ (deferred):**

- GCS backend (`@google-cloud/storage`) -- deferred to reduce V1 scope and dependencies
- Azure backend
- Transfer tool delegation (aws-cli, rclone, gsutil) -- ship V1 with SDK-only transfer
- Real-cloud S3/GCS e2e tests (nightly CI with credentials)
- `blobsy stats` command (aggregate statistics)
- Enhanced `blobsy doctor` (deeper diagnostics)
- `blobsy status` with file sizes in human output

## Open Questions

1. **MinIO in CI?** Docker-based MinIO gives us S3-compatible testing on every PR
   without cloud credentials.
   Worth the CI complexity?
   Alternative: mock S3 at the SDK level.

2. **Scope of `blobsy prime`?** How much status information should `prime` show?
   Minimal (version + init state) or full (tracked files, backend health, stat cache
   summary)?

## References

- [Phase 1 Plan](plan-2026-02-21-blobsy-phase1-implementation.md)
- [blobsy-design.md](../../design/current/blobsy-design.md)
- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md)
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md)
- [blobsy-implementation-notes.md](../../design/current/blobsy-implementation-notes.md)
- `tbd guidelines typescript-cli-tool-rules`
- `tbd guidelines cli-agent-skill-patterns`
