# Feature: Golden Test Quality Improvement

**Date:** 2026-02-21

**Author:** AI Engineering Review

**Status:** In Progress

**Last reviewed:** 2026-02-21

## Overview

A systematic overhaul of the tryscript golden tests to align them with the golden
testing philosophy established in
[blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) and
[golden-testing-guidelines](https://github.com/jlevy/tbd).

**Current state (as of latest review):** 41 test files, 52 unnamed wildcards (44 `...` +
8 `[..]`) across 19 files.
22 files are now clean (0 unnamed wildcards).
Down from the original baseline of 39 files with ~71 `...` elisions.

## Goals

- Eliminate the `...` output suppression anti-pattern across all test files
- Capture full command output in every console block so behavioral changes surface as
  diffs
- Add filesystem inspection (`find`, `cat`) after all state-changing operations
- Verify JSON output structure in all `json/` tests
- Verify echo backend transport commands in all `echo-backend/` tests
- Close coverage gaps identified against the design spec
- Ensure every command’s full behavior (success + error paths) is exercised with
  complete output

## Non-Goals

- Adding cloud backend tests (S3, GCS, Azure) -- those require credentials
- Adding performance tests or benchmarks
- Implementing new CLI features (this is test-only)
- Changing the tryscript infrastructure or config

## Background

The [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) is
explicit:

> **Show everything, hide nothing.** Golden tests capture the full output of every
> command. No `grep`, no `jq`, no assertion on a single field.

> **Diffs are the test oracle.** When behavior changes intentionally, you run
> `tryscript run --update`, review the diff, and commit it.

> **Inspect the filesystem, not just the CLI.** After major operations, run
> `find . -not -path './.git/*' | sort` and `cat` key files to show the exact filesystem
> state.

### Named Pattern Rules

Named patterns (`[HASH]`, `[REMOTE_KEY]`, etc.)
exist **only** for fields that are genuinely unstable across test runs.
A field is unstable if it changes every time the test executes in a fresh sandbox, even
with the same inputs.

**Unstable (use named patterns):**

- Content hashes (`[HASH]`) -- derived from file content but printed in full SHA-256
  form that is hard to verify by eye
- Remote keys (`[REMOTE_KEY]`) -- contain timestamps from the push moment
- Timestamps (`[TIMESTAMP]`) -- wall-clock times
- Sandbox/temp paths (`[SANDBOX_PATH]`) -- OS-assigned temp directory names
- Temp file paths (`[TMPFILE]`) -- random temp filenames

**Stable (use literal values, never wildcards):**

- File sizes -- fixture files have fixed content, so sizes are deterministic.
  Write `(13 B)` not `([SIZE] B)`.
- File counts -- the number of files in a listing is deterministic.
  Write `2` not `[..]`.
- Status symbols and labels (`○`, `✓`, `↑`, `↓`, `up to date`, `pushed`, etc.)
- Error messages -- the text of an error is part of the contract.
  Write the full error, not `[..]`.
- Config values, help text, command names -- all deterministic.

**Rule of thumb:** if the same input always produces the same output, it is stable and
must be captured literally.
Using a wildcard on a stable field is a test quality bug -- it hides regressions.

Existing `[SIZE]` patterns in older test files should be replaced with literal values as
those files are updated.

### Severity Classification

Issues are classified by impact:

- **P0 (Critical)**: Test claims to verify something but actually verifies nothing due
  to output suppression.
  Changes to the tested behavior would silently pass.
- **P1 (High)**: Missing coverage for behavior specified in the design doc.
  A regression in that behavior would not be caught.
- **P2 (Medium)**: Insufficient filesystem inspection.
  Side effects (leftover temp files, missing gitignore entries) would not be caught.
- **P3 (Low)**: Missing edge cases or minor enhancements that would improve coverage.

* * *

## Complete Unnamed Wildcard Inventory

52 unnamed wildcards (44 `...` + 8 `[..]`) across 19 files.
Categorized by what they suppress and how to fix them.

### Category A: Blobsy Command Output Suppressed (35 `...`)

These suppress deterministic blobsy output that should be captured in full.
**Fix:** Run `tryscript run --update` for each file, then review and replace any
genuinely dynamic fields with named patterns (`[HASH]`, `[REMOTE_KEY]`, `[SIZE]`).

#### `commands/sync.tryscript.md` -- 4 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 24 | `blobsy sync` | Per-file push lines before summary |
| 41 | `blobsy sync` | “Up to date” details |
| 61 | `blobsy sync` (after modify) | Per-file push details |
| 83 | `blobsy sync` (after delete) | Per-file pull details |

#### `commands/check-unpushed.tryscript.md` -- 3 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 24 | `blobsy check-unpushed` | File list (2 not pushed) |
| 40 | `blobsy check-unpushed` | File list (1 not pushed) |
| 49 | `blobsy push` | Per-file push output |

#### `commands/mv.tryscript.md` -- 2 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 127 | `blobsy track data/research/` | Scan details before “2 files tracked.” |
| 136 | `blobsy mv data/research archive/research` | Move details |

#### `commands/pre-push-check.tryscript.md` -- 1 elision

| Line | Command | What is suppressed |
| --- | --- | --- |
| 21 | `blobsy pre-push-check` | Failure details (which files missing) |

#### `workflows/multi-file-sync.tryscript.md` -- 5 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 19 | `blobsy track data/models/` | Scan/track details |
| 25 | `blobsy track data/datasets/` | Scan/track details |
| 38 | `blobsy push` | Per-file push details before “Done: 6 pushed.” |
| 60 | `blobsy verify` | Per-file verification details |
| 74 | `blobsy sync` | Per-file sync details |

#### `workflows/branch-workflow.tryscript.md` -- 5 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 23 | `blobsy status` (on main) | Per-file status lines |
| 75 | `blobsy status` (on feature) | Per-file status lines |
| 97 | `blobsy status` (after merge) | Per-file status lines |
| 106 | `blobsy sync` | Sync details |
| 115 | `blobsy verify` | Verification details |

#### `workflows/fresh-setup.tryscript.md` -- 4 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 67 | `blobsy push` | Per-file push details |
| 91 | `blobsy status` | Per-file status lines |
| 105 | `blobsy pull` | Per-file pull details |
| 128 | `blobsy verify` | Verification details |

#### `workflows/modify-and-resync.tryscript.md` -- 2 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 22 | `blobsy status` | Per-file status lines |
| 86 | `blobsy status` | Per-file status lines |

#### `workflows/two-user-conflict.tryscript.md` -- 1 elision

| Line | Command | What is suppressed |
| --- | --- | --- |
| 23 | `blobsy status` | Per-file status lines |

#### `echo-backend/sync-commands.tryscript.md` -- 2 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 38 | `blobsy sync --skip-health-check` | Per-file sync details |
| 60 | `blobsy sync --skip-health-check` | Per-file sync details |

#### `errors/conflict-errors.tryscript.md` -- 3 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 23 | `blobsy pull data/model.bin` | Pull output (up to date) |
| 38 | `blobsy pull data/model.bin` (after modify) | Pull output (overwrite/refuse behavior) |
| 61 | `blobsy pull --force data/model.bin` | Force pull output |

#### `errors/partial-failure.tryscript.md` -- 3 elisions

| Line | Command | What is suppressed |
| --- | --- | --- |
| 30 | `blobsy push data/good-file.bin` | Success output |
| 45 | `blobsy push data/bad-file.bin 2>&1` | Error output |
| 60 | `blobsy push` | Push-all output |

#### `errors/not-found-errors.tryscript.md` -- 1 elision

| Line | Command | What is suppressed |
| --- | --- | --- |
| 38 | `blobsy push data/untracked.bin 2>&1` | Error message |

### Category B: Long/Dynamic Output -- skill/prime (4 `...` + 2 `[..]`)

These commands produce long markdown output that changes frequently.
The `...` is arguably more defensible here, but the current tests also use surgical
`head -3` and `grep -c` checks that add no golden value.

#### `commands/skill.tryscript.md` -- 2 `...` + 1 `[..]`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 9 | `blobsy skill --brief` | Brief output after first line |
| 18 | `blobsy skill \| head -3` | After first line of piped output |
| 24 | `blobsy skill \| grep -c '##'` | Section count |

#### `commands/prime.tryscript.md` -- 2 `...` + 1 `[..]`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 9 | `blobsy prime --brief` | Brief output after first line |
| 18 | `blobsy prime \| head -3` | After first line of piped output |
| 24 | `blobsy prime \| grep -c 'blobsy'` | Word count |

**Fix:** At minimum, capture the `--brief` output in full (it is short and stable).
For full output, either capture it entirely or justify the elision with a comment.
Remove the `grep -c` / `head` pipe blocks -- they add nothing as golden tests.

### Category C: Error Messages Suppressed (2 `...` + 3 `[..]`)

These suppress error messages that should be captured to detect changes in error text.

#### `errors/validation-errors.tryscript.md` -- 2 `...`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 46 | `blobsy init 2>&1` | Missing-arg error (also in init.tryscript.md) |
| 55 | `blobsy init r2://bucket/prefix/ 2>&1` | Supported-schemes list after first error line |

#### `commands/health.tryscript.md` -- 2 `[..]`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 34 | `blobsy health 2>&1` (remote gone) | Error message for missing remote |
| 52 | `blobsy health 2>&1` (no perms) | Error message for unwritable remote |

#### `commands/init.tryscript.md` -- 1 `[..]`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 65 | `blobsy init s3://AB/prefix/ 2>&1` | Invalid S3 bucket error message |

**Fix:** Replace `[..]` and `...` with the actual error text.
If the error includes a system-specific path, use a named pattern.

### Category D: Non-Blobsy Output / Surgical Checks (2 `[..]` + 1 `[..]`)

#### `workflows/branch-workflow.tryscript.md` -- 2 `[..]`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 32 | `git checkout -b feature/new-data 2>&1` | Git branch switch message |
| 84 | `git checkout main 2>&1` | Git checkout message |

**Fix:** These are legitimately variable (git version-dependent).
Replace with a named pattern like `[GIT_MSG]` or keep `[..]` but add a regex pattern for
the expected git checkout output format.

#### `commands/untrack.tryscript.md` -- 1 `[..]`

| Line | Command | What is suppressed |
| --- | --- | --- |
| 59 | `ls .blobsy/trash/ \| wc -l` | Trash count |

**Fix:** Replace the `wc -l` pipe with a direct `ls .blobsy/trash/` or
`find .blobsy/trash/ -type f` to show actual trash contents instead of counting.

### Summary by Category

| Category | `...` | `[..]` | Total | Priority |
| --- | --- | --- | --- | --- |
| A: Blobsy output suppressed | 35 | 0 | 35 | P0 -- fix first |
| B: skill/prime long output | 4 | 2 | 6 | P2 -- capture --brief, justify long |
| C: Error messages suppressed | 2 | 3 | 5 | P1 -- show full errors |
| D: Non-blobsy / surgical | 0 | 3 | 3 | P3 -- use named patterns |
| **Total** | **41** | **8** | **49** |  |

Note: 3 wildcards are not counted in categories above because the `...` count (44) minus
category sums (41) = 3 overlap with Category A entries that also appear in error files.
The true deduplicated total is 52 wildcard instances across 19 files.

* * *

## Issue Status (30 Issues)

### Fully Addressed

#### Issue 7: Help Test Missing Commands (P1) -- DONE

All 19 commands now have `--help` golden output in `commands/help.tryscript.md`. Zero
unnamed wildcards. Complete coverage of the CLI surface.

#### Issue 21: Malformed Command Blocks in `track` Test (P0) -- DONE

`commands/track.tryscript.md` now has clean, separate `$` lines for each command.
Has 3 `find` commands and 3 `cat` commands for filesystem inspection.
Zero unnamed wildcards.

### Substantially Improved (Not Yet Complete)

#### Issue 1: Pervasive Output Suppression (P0)

**Original:** ~21 of 39 files, ~71 `...` elisions.
**Current:** 19 of 41 files, 52 unnamed wildcards (44 `...` + 8 `[..]`).

22 files are now clean.
The following files were cleaned up from the original review:

- `commands/push-pull.tryscript.md` -- was fully suppressed, now 0 elisions
- `commands/doctor.tryscript.md` -- was fully suppressed, now 0 elisions
- `commands/health.tryscript.md` -- was fully suppressed, now 2 `[..]` for errors only
- `workflows/compression.tryscript.md` -- was fully suppressed, now 0 elisions
- `workflows/doctor-fix.tryscript.md` -- was fully suppressed, now 0 elisions
- `echo-backend/push-commands.tryscript.md` -- was fully suppressed, now 0 elisions
- `echo-backend/pull-commands.tryscript.md` -- was fully suppressed, now 0 elisions
- `echo-backend/compression-commands.tryscript.md` -- was fully suppressed, now 0
  elisions

**Remaining:** See Complete Unnamed Wildcard Inventory above for the full per-file,
per-line breakdown.

**Resolution:** Work through the inventory file by file.
The Category A items (35 `...` suppressing deterministic blobsy output) are the highest
priority.

#### Issue 3: Echo Backend Tests Hide Transport Commands (P0)

**Improved:** 3 of 4 echo backend files now have 0 elisions with `find .mock-remote` and
`cat` content verification.
**Remaining:** `echo-backend/sync-commands.tryscript.md` still has 2 `...` elisions.
**Also:** None of the echo backend tests show the actual `PUSH`/`PULL` transport echo
lines from the command backend -- they only show blobsy’s own output.
The testing design doc says the echo backend’s purpose is transport-layer visibility.

**Resolution:** Fix sync-commands elisions.
Investigate whether the echo backend script currently prints transport commands to
stdout and if so, ensure they appear in test output.

#### Issue 4: Missing Filesystem Inspections (P2)

**Improved:** track (3 `find`, 3 `cat`), push-pull (1 `find`, 1 `cat`), rm (1 `find`, 1
`cat`), compression workflow (`find` for compressed blob), two-user-conflict (1 `find`,
1 `cat`), fresh-setup (1 `find`, 2 `cat`), echo-backend push/compression
(`find .mock-remote`).

**Remaining gaps:**
- `commands/sync.tryscript.md` -- no filesystem inspection
- `commands/status.tryscript.md` -- no filesystem inspection
- `commands/untrack.tryscript.md` -- uses `wc -l` instead of showing trash contents; no
  gitignore verification after untrack
- Most workflows still lack full remote store listing (`find remote/ -type f | sort`)
- Remote checks in workflows use `wc -l` or `test -n` instead of full listings

#### Issue 5: Status Test Missing Key States (P1)

**Improved:** Now covers 4 of 7 states: empty, `○` (not pushed), `~` (modified), `?`
(missing). **Remaining:** `◐` (committed not synced), `◑` (synced not committed), `✓`
(fully synced), `⊗` (staged for deletion) are still missing from
`commands/status.tryscript.md`. Note: `json/status-json.tryscript.md` covers additional
states but only in JSON form.

#### Issue 8: Doctor Tests Are Minimal (P1)

**Improved:** Both `commands/doctor.tryscript.md` and
`workflows/doctor-fix.tryscript.md` now show full output (0 elisions) with a healthy ->
break -> detect -> fix -> verify cycle.
**Remaining:** Only one diagnostic scenario tested (missing gitignore entry).
Missing: orphaned gitignore, invalid .yref, stale stat cache, missing hook, orphaned
temp files, connectivity check.

#### Issue 11: Push-Pull Missing Key Scenarios (P1)

**Improved:** 0 elisions.
Shows `remote_key` verification (`grep`), remote store check (`test -n "$(find ...)"`),
pulled content verification (`cat`), force push with re-track.
**Remaining:** Push with uncommitted refs (warning), pull when modified (exit code 2
error) are still missing.
Note: conflict-errors.tryscript.md partially covers pull-when-modified but suppresses
the output.

#### Issue 15: Hooks Test Missing Execution Test (P2)

**Improved:** Install/uninstall/edge cases fully covered with 0 elisions.
Shows hook file header, handles non-blobsy hook refusal.
**Remaining:** No test of actual hook execution during `git commit`.

#### Issue 17: Quiet/Dry-Run Tests Incomplete (P3)

**Improved:** Both files have 0 elisions.
`dry-run` covers track, untrack, rm, and `--dry-run --json`. `quiet` covers track,
`--quiet + --verbose` conflict, `--quiet + --json`. **Remaining:** `--quiet` and
`--dry-run` not tested with push, pull, sync.

#### Issue 18: Missing Compression Edge Cases (P3)

**Improved:** zstd path well covered in both workflow and echo-backend with round-trip
verification. **Remaining:** No tests for gzip/brotli algorithms, `never` patterns,
`min_size` threshold behavior.

#### Issue 25: Missing Tests for skill/prime (P1)

**Improved:** Both files now exist (`commands/skill.tryscript.md`,
`commands/prime.tryscript.md`). Help test includes both commands.
**Remaining:** Both files are surgical -- use `head -3`, `grep -c`, and `...` instead of
capturing actual output.
See Category B in the wildcard inventory.

#### Issue 28: Path Form and Scope Matrix (P2)

**Improved:** `track` tests both `file` and `file.yref` path forms, and directory scope.
**Remaining:** Other commands don’t systematically test path forms.

### Not Addressed

#### Issue 2: JSON Coverage Breadth Limited (P1)

Still only 5 dedicated JSON files covering: `status`, `verify`, `push/pull`, `sync`,
`doctor`. The `dry-run` and `quiet` tests include some JSON examples, but ~14 commands
still lack JSON golden coverage.

#### Issue 6: Conflict Testing Incomplete (P1)

`errors/conflict-errors.tryscript.md` still tests pull behavior (not real conflict
detection) and suppresses all output (3 `...`).
`workflows/two-user-conflict.tryscript.md` still only tests force-push scenario.
No test exercises the three-way merge conflict path (local != ref != cache).

#### Issue 9: Config Test Missing Set Operation (P2)

`commands/config.tryscript.md` only reads config values.
No `blobsy config key value` set operation tested.

#### Issue 10: Init Test Missing Error Cases (P2)

Same scenarios as before.
Missing: S3/GCS/Azure URL config shape, `--region`/`--endpoint`, init outside git repo,
local path inside repo.
1 `[..]` suppresses the S3 bucket error message.

#### Issue 12: Sync Missing Key Scenarios (P1)

4 `...` elisions remain.
Missing: health check failure, conflict detection, partial failure,
`--skip-health-check`, per-file action detail output.

#### Issue 13: Validation Errors Missing Design Spec Cases (P2)

2 `...` elisions. Missing: malformed `.yref`, unsupported format version.

#### Issue 14: Not-Found Errors Missing Pull Scenario (P2)

1 `...` elision. Missing: pull when remote blob doesn’t exist.

#### Issue 19: Workflow Tests Need Remote State Verification (P2)

Some workflows have partial remote checks (`test -n`, `wc -l`) but none show full
`find remote/ -type f | sort` listings.

#### Issue 20: Missing Externalization Rules Test (P2)

No test exercises `min_size`, `never` patterns, or `ignore` patterns for directory
tracking.

#### Issue 22: Harness Backend Override Masks Resolution (P1)

`tryscript.config.ts` still sets `BLOBSY_BACKEND_URL` globally.
Some tests override to `""` but most use the global override, meaning `.blobsy.yml`
backend resolution is not exercised.

#### Issue 23: Shared Suite-Wide Remote Reduces Determinism (P1)

Single shared `testRemote` directory still in use.
Root cause of `wc -l` and `test -n` in remote inspection steps (can’t assert full
listing because other tests may have pushed to the same remote).

#### Issue 24: JSON Coverage Incomplete Across Surface (P1)

Same as Issue 2. ~14 commands still missing JSON golden tests.

#### Issue 27: Global Flag Matrix Incomplete (P2)

`--verbose` has no positive behavior test.
`--force` and `--skip-health-check` are tested in specific files but not systematically.

#### Issue 29: Failure-Path JSON Assertions Missing (P2)

No JSON-mode error tests for validation, conflict, not-found, permission categories.

#### Issue 30: No Guardrail for Coverage Drift (P2)

No coverage matrix or CI check.

* * *

## Summary Scorecard

| Status | Count | Issues |
| --- | --- | --- |
| Fully addressed | 2 | 7, 21 |
| Substantially improved | 11 | 1, 3, 4, 5, 8, 11, 15, 17, 18, 25, 28 |
| Not addressed | 17 | 2, 6, 9, 10, 12, 13, 14, 16, 19, 20, 22, 23, 24, 26, 27, 29, 30 |

## Implementation Plan (Revised)

### Track A: Signal Restoration (P0/P1 -- do first)

Priority: eliminate the 35 Category A wildcards that suppress deterministic blobsy
output.

- [x] Fix malformed command blocks in track test (Issue 21)
- [x] Clean push-pull, doctor, health, compression, doctor-fix, echo-backend push/pull/
  compression (Issue 1 partial)
- [ ] Fix `commands/sync.tryscript.md` -- 4 `...` (replace with full per-file output)
- [ ] Fix `commands/check-unpushed.tryscript.md` -- 3 `...`
- [ ] Fix `commands/mv.tryscript.md` -- 2 `...` (show track scan + mv details)
- [ ] Fix `commands/pre-push-check.tryscript.md` -- 1 `...`
- [ ] Fix `echo-backend/sync-commands.tryscript.md` -- 2 `...`
- [ ] Fix `workflows/multi-file-sync.tryscript.md` -- 5 `...`
- [ ] Fix `workflows/branch-workflow.tryscript.md` -- 5 `...`
- [ ] Fix `workflows/fresh-setup.tryscript.md` -- 4 `...`
- [ ] Fix `workflows/modify-and-resync.tryscript.md` -- 2 `...`
- [ ] Fix `workflows/two-user-conflict.tryscript.md` -- 1 `...`
- [ ] Fix `errors/conflict-errors.tryscript.md` -- 3 `...`
- [ ] Fix `errors/partial-failure.tryscript.md` -- 3 `...`
- [ ] Fix `errors/not-found-errors.tryscript.md` -- 1 `...`
- [ ] Fix `errors/validation-errors.tryscript.md` -- 2 `...`
- [ ] Fix `commands/health.tryscript.md` -- 2 `[..]` (show full error messages)
- [ ] Fix `commands/init.tryscript.md` -- 1 `[..]` (show full S3 error)
- [ ] Fix `commands/untrack.tryscript.md` -- 1 `[..]` (show trash contents instead of
  count)
- [ ] Fix `commands/skill.tryscript.md` -- capture `--brief` in full, remove `grep -c`
  block
- [ ] Fix `commands/prime.tryscript.md` -- capture `--brief` in full, remove `grep -c`
  block

**Method:** For each file, run `npx tryscript run --update <file>` from
`packages/blobsy/`, review the diff, replace dynamic values with named patterns, commit.

### Track B: Scenario Completeness (P1/P2)

After Track A is complete, fill coverage gaps:

- [ ] Issue 5: Add `◐`, `◑`, `✓`, `⊗` states to status test
- [ ] Issue 6: Rewrite conflict-errors to test real conflict detection; add three-way
  merge conflict to two-user-conflict
- [ ] Issue 8: Add doctor scenarios for orphaned gitignore, invalid .yref, stale cache
- [ ] Issue 11: Add push-with-uncommitted-refs and pull-when-modified scenarios
- [ ] Issue 12: Add sync health-failure, conflict, partial-failure, --skip-health-check
  scenarios
- [ ] Issue 9: Add config set operation test
- [ ] Issue 10: Add S3/GCS/Azure config shape tests, init outside git, --region/
  --endpoint
- [ ] Issue 13: Add malformed .yref and unsupported format version tests
- [ ] Issue 14: Add pull-with-missing-remote-blob test
- [ ] Issue 15: Add hook execution test during git commit
- [ ] Issue 20: Add externalization rules test (min_size, never, ignore patterns)
- [ ] Issue 2/24: Add JSON golden tests for remaining ~14 commands
- [ ] Issue 29: Add JSON-mode error tests

### Track C: Harness and Governance (P1/P2)

- [ ] Issue 22: Remove global `BLOBSY_BACKEND_URL` from tryscript.config.ts; let each
  test resolve backend from `.blobsy.yml`
- [ ] Issue 23: Isolate remote state per test file to enable strict remote listing
  assertions
- [ ] Issue 4: Once remotes are isolated, replace `wc -l`/`test -n` remote checks with
  full `find remote/ -type f | sort` listings
- [ ] Issue 19: Add full remote store listings in all workflow tests after push
- [ ] Issue 27: Add global flag matrix (--verbose, --force, --skip-health-check)
- [ ] Issue 28: Add path form/scope matrix for all mutating commands
- [ ] Issue 30: Add coverage matrix doc and CI check

## Sequencing Relative to Phase 1 and Phase 2 Specs

### Immediate: Track A Signal Restoration

These are corrections to Phase 1 deliverables.
Can be done mechanically with `tryscript run --update` + review.
Should happen before further feature work.

### Phase 2 Stage 1 Alignment (CLI Polish)

As `--dry-run`, quiet semantics, and error text are finalized:

- [ ] Issue 17 remaining: quiet/dry-run with push, pull, sync
- [ ] Issue 27 global flag matrix
- [ ] Issue 29 JSON error-path coverage
- [ ] Refresh snapshots affected by error quality pass

### Phase 2 Stage 2 Alignment (S3 Backend)

- [ ] Issue 22 + 23: harness backend resolution and isolation
- [ ] S3-specific golden scenarios

### Phase 2 Stage 3 Alignment (E2E / MinIO)

- [ ] Extend error coverage for auth/permission/network using MinIO
- [ ] Expand sync partial-failure and conflict scenarios

### Phase 2 Stage 4 Alignment (Docs + Agent Integration)

- [ ] Issue 25: capture full skill/prime output
- [ ] Validate agent-facing output stability

### Phase 2 Stage 5 Alignment (Release Readiness)

- [ ] Issue 30: coverage matrix and CI guardrail
- [ ] Final golden baseline update and diff review

## Testing Strategy and Gates

For every tranche above:

1. Run `npx tryscript run tests/golden/` from `packages/blobsy/`
2. Run `pnpm test` in `packages/blobsy/`
3. Review golden diffs manually (no blind `--update` commits)
4. Ensure no new `...` elisions are introduced except where explicitly justified
5. Confirm harness isolation assumptions still hold

Release gate:

- [ ] All command help and JSON contracts are snapshot-covered
- [ ] Trust/security behavior has explicit deny/allow tests
- [ ] Zero unnamed wildcards suppressing deterministic blobsy output
- [ ] Coverage matrix is complete for all shipped commands in CLI registration

## References

- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md)
- [blobsy-design.md](../../design/current/blobsy-design.md)
- [plan-2026-02-21-blobsy-phase1-implementation.md](plan-2026-02-21-blobsy-phase1-implementation.md)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md](plan-2026-02-21-blobsy-phase2-v1-completion.md)
- `tbd guidelines golden-testing-guidelines`
- `npx tryscript@latest docs`
