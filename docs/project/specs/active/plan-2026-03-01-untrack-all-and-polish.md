---
title: Untrack All and Untrack UX Polish
description: Add a repo-wide untrack-all command path and tighten untrack UX/docs/testing
author: Codex (GPT-5)
---
# Feature: Untrack All and Untrack UX Polish

**Date:** 2026-03-01 (last updated 2026-03-01)

**Author:** Codex (GPT-5)

**Status:** Draft

## Overview

Add a first-class `blobsy untrack --all` operation that always targets the entire
repository regardless of current working directory, plus a small set of untrack UX
polish changes (validation, help text, dry-run clarity, and docs/test coverage).

This is intentionally not just a synonym for `blobsy untrack --recursive .`.
`--recursive .` is current-directory scoped; `--all` is repository scoped.

## Goals

- Add `blobsy untrack --all` for fast, explicit repo-wide untrack.
- Make semantics unambiguous from any subdirectory.
- Preserve current safety model and non-destructive behavior (local files kept, remote
  blobs untouched).
- Fully document and test the new behavior.

## Non-Goals

- Do not add remote blob deletion to `untrack`.
- Do not change `untrack` trash behavior.
- Do not change `rm` semantics.
- Do not redesign JSON schemas for unrelated commands.

## Background

Current behavior requires file paths or directory paths:

- File: `blobsy untrack path/to/file`
- Directory: `blobsy untrack --recursive path/to/dir`

Users can approximate repo-wide untrack with `blobsy untrack --recursive .` from repo
root, but this is easy to get wrong when running from a subdirectory.
The UX need is an explicit full-repo command that behaves the same from anywhere inside
the repo.

## Design

### Approach

Introduce a dedicated `--all` flag on `untrack`:

- `blobsy untrack --all`:
  - Resolves repo root via existing `findRepoRoot()`.
  - Enumerates tracked files by scanning `.bref` files from repo root.
  - Untracks each tracked file with the same behavior as single-file untrack.
- Continue supporting existing path-based untrack behavior.

### Behavior Contract

- `blobsy untrack --all`
  - Repo-wide operation from any cwd.
  - Equivalent result no matter where command is run inside the repo.
- `blobsy untrack --recursive <dir>`
  - Directory-scoped operation.
- Invalid combinations:
  - `--all` with explicit paths -> error.
  - `--all` with `--recursive` -> error.
- If neither `--all` nor paths are provided -> error with actionable usage guidance.
- If `--all` finds no tracked files -> successful no-op with clear message.
- Output contract:
  - Human output keeps current per-file untrack lines and adds a final summary line for
    `--all` (for example: `Untracked 47 files across repository`).
  - `--json` keeps line-oriented JSON messages (`formatJsonMessage` style) to preserve
    existing command-output shape expectations; no new summary JSON schema is
    introduced.
  - `--dry-run` mirrors normal behavior and prints `Would untrack <path>` entries for
    all affected files.

### Components

- CLI parsing and validation for `untrack`.
- Untrack planner/execution path for repo-wide target collection.
- Help text and docs for new flag semantics.
- Golden tests for help/behavior/error/dry-run/json.

### API Changes

Command interface changes:

- From: `blobsy untrack [--recursive] <path...>`
- To: `blobsy untrack [--recursive] [--all] [path...]`

Notes:

- `path` becomes optional at parse level to permit `--all` without path.
- Handler enforces valid argument combinations.

## Detailed Change Map

### Documentation Changes

1. `docs/project/design/current/blobsy-design.md`
- Path behavior table: distinguish directory-recursive vs repo-wide-all semantics.
- `blobsy untrack` section: add `--all` behavior and examples from subdirectory.
- Flags table: add `--all`.
- CLI command summary: include `blobsy untrack --all`.

2. `docs/project/design/current/blobsy-testing-design.md`
- Golden organization: add planned untrack-all golden coverage.
- Coverage bullets: add repo-wide gitignore cleanup expectations.

3. `packages/blobsy/docs/blobsy-docs.md`
- Add explicit repo-wide reset guidance: `blobsy untrack --all`.
- Clarify difference vs `--recursive <dir>`.

4. `packages/blobsy/docs/blobsy-docs-brief.md`
- Add quick command reference line for `untrack --all`.

5. `testing/qa/blobsy-end-to-end.qa.md`
- Add one QA step for undoing a batch track operation with `--all`.
- Add expected output and verification checklist.

6. `docs/development.md`
- Add a short “reset tracked state” note in QA flow with `blobsy untrack --all`.

### Code Changes

1. `packages/blobsy/src/cli.ts`
- Update `untrack` command declaration:
  - add `--all`
  - make `path` optional at parser level
- Update `handleUntrack()`:
  - implement argument validation matrix
  - add repo-root collection path for `--all`
  - preserve current file/dir untrack behavior
- Keep `untrackFile()` semantics unchanged (trash, gitignore update, stat-cache cleanup,
  `git rm --cached` of `.bref`).

2. (Optional small refactor) `packages/blobsy/src/cli.ts` or
   `packages/blobsy/src/paths.ts`
- Add a tiny helper for obtaining all tracked paths from repo root if it improves
  readability and testability.

### Test Changes

1. `packages/blobsy/tests/golden/commands/help.tryscript.md`
- Update untrack help usage/options to include `--all`.

2. `packages/blobsy/tests/golden/commands/untrack.tryscript.md`
- Add cases:
  - `untrack --all` from repo root
  - `untrack --all` from nested subdirectory
  - invalid combinations (`--all` with path, `--all` with `--recursive`)
  - no-op behavior when no tracked files exist

3. `packages/blobsy/tests/golden/commands/dry-run.tryscript.md`
- Add `--dry-run untrack --all` case.

4. `packages/blobsy/tests/golden/json/untrack-rm-json.tryscript.md`
- Add/adjust `--json` behavior assertions for `untrack --all`.

5. `packages/blobsy/tests/golden/commands/untrack-staging.tryscript.md`
- Add verification that `.bref` removals and `.gitignore` updates are staged for
  multi-file repo-wide untrack.

## Implementation Plan

### Phase 1: Untrack-All + UX Polish

- [x] Finalize behavior decisions in this spec (validation matrix, output expectations).
- [x] Implement CLI parsing/handler changes for `untrack --all`.
- [x] Add/adjust golden tests for help, behavior, errors, dry-run, and JSON modes.
- [x] Update user docs, design docs, and QA/development docs.
- [x] Run build/tests and confirm command behavior from repo root and subdirectories.

## Testing Strategy

- Golden tests:
  - untrack help and usage
  - repo-wide behavior from nested cwd
  - invalid flag/path combinations
  - dry-run and json output
- Existing suite validation:
  - `pnpm --filter blobsy test`
- Targeted manual smoke:
  - create tracked files in multiple folders
  - run `blobsy untrack --all` from nested directory
  - verify `.bref` moved to trash, local files preserved, git staged changes correct

## Rollout Plan

- Ship as backward-compatible CLI enhancement.
- Mention in changelog as a usability improvement.
- Encourage `--all` for full-repo cleanup instead of relying on cwd-sensitive commands.

## Open Questions

- Should `untrack --all` include `--force` in a future release if a confirmation prompt
  is ever added?

## References

- `docs/project/design/current/blobsy-design.md`
- `docs/project/design/current/blobsy-testing-design.md`
- `packages/blobsy/src/cli.ts`
- `packages/blobsy/tests/golden/commands/untrack.tryscript.md`
