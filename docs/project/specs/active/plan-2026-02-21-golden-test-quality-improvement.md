# Feature: Golden Test Quality Improvement

**Date:** 2026-02-21

**Author:** AI Engineering Review

**Status:** Stage 1 Complete, Stage 2 Pending

**Last reviewed:** 2026-02-22

## Overview

A systematic overhaul of the tryscript golden tests to align them with the golden
testing philosophy established in
[blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) and
[golden-testing-guidelines](https://github.com/jlevy/tbd).

**Stage 1 (Complete):** 49 test files, 432 expectations, 2 remaining unnamed wildcards
(both `[..]` for git version-dependent messages in `branch-workflow.tryscript.md`). All
deterministic blobsy output is now captured literally.
Up from 39 files / ~71 `...` elisions at baseline.
All 30 issues addressed.
Coverage matrix and CI guardrail in place.

**Stage 2 (Pending):** Replace Docker-dependent S3 e2e test with a CI-friendly
alternative that runs without Docker on any Linux machine (GitHub Actions).

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

## Issue Status (30 Issues)

### Fully Addressed (28 of 30)

| Issue | Severity | Title | Status |
| --- | --- | --- | --- |
| 1 | P0 | Pervasive output suppression | DONE -- 0 `...`, 2 `[..]` for git messages |
| 2/24 | P1 | JSON coverage | DONE -- 11 JSON test files |
| 3 | P0 | Echo backend transport visibility | DONE -- 0 elisions in all 4 files |
| 4 | P2 | Filesystem inspections | DONE -- full `find` listings, no `wc -l` |
| 5 | P1 | Status test key states | DONE -- tests all implemented states |
| 6 | P1 | Conflict testing | DONE -- full output in conflict/two-user tests |
| 7 | P1 | Help test missing commands | DONE -- all 19 commands |
| 8 | P1 | Doctor test scenarios | DONE -- orphaned .yref, missing .blobsy, --fix |
| 9 | P2 | Config set operation | DONE |
| 10 | P2 | Init error cases | DONE -- S3/GCS/Azure shapes, literal errors |
| 11 | P1 | Push-pull scenarios | DONE -- .yref paths, full output |
| 12 | P1 | Sync scenarios | DONE -- health failure, --skip-health-check |
| 13 | P2 | Validation error cases | DONE -- malformed .yref |
| 14 | P2 | Not-found pull scenario | DONE -- missing remote blob |
| 15 | P2 | Hooks execution test | DONE -- git commit with hook |
| 19 | P2 | Workflow remote verification | DONE -- full `find` with `[REMOTE_KEY]` |
| 20 | P2 | Externalization rules | DONE -- min_size, never patterns |
| 21 | P0 | Malformed command blocks | DONE |
| 22 | P1 | Harness backend override | DONE -- global URL removed |
| 23 | P1 | Shared suite-wide remote | DONE -- per-sandbox isolation |
| 25 | P1 | skill/prime tests | DONE -- full --brief output |
| 27 | P2 | Global flag matrix | DONE -- verbose, force, skip-health-check |
| 28 | P2 | Path form matrix | DONE -- file, .yref, directory forms |
| 17 | P3 | Quiet/dry-run with push/pull/sync | DONE -- appended to quiet.tryscript.md, dry-run.tryscript.md |
| 18 | P3 | Compression edge cases | DONE -- gzip, brotli, min_size, never patterns |
| 29 | P2 | JSON error assertions | DONE -- errors-json.tryscript.md |
| 30 | P2 | Coverage matrix and CI guardrail | DONE -- matrix doc + check script |

### Closed as Not Applicable (2)

| Issue | Severity | Title | Notes |
| --- | --- | --- | --- |
| 16 | P3 | Trust/security test | Trust feature removed from CLI |
| 26 | P3 | Trust security workflow | Trust feature removed from CLI |

* * *

## Test Suite Summary

### Coverage by Directory

| Directory | Files | Expectations | Description |
| --- | --- | --- | --- |
| `commands/` | 22 | 235 | Per-command golden tests |
| `json/` | 11 | 39 | JSON output verification |
| `workflows/` | 8 | 106 | Multi-step workflow scenarios |
| `echo-backend/` | 4 | 23 | Transport layer visibility |
| `errors/` | 4 | 29 | Error path coverage |
| **Total** | **49** | **432** |  |

### Wildcard Status

| Metric | Baseline | Current |
| --- | --- | --- |
| Files with unnamed wildcards | 21 of 39 | 1 of 49 |
| `...` elisions | ~71 | 0 |
| `[..]` elisions | ~8 | 2 (git version messages) |
| Named patterns in use | HASH, REMOTE_KEY, TIMESTAMP, TMPFILE | + SANDBOX_PATH, LOCAL_PATH, UNIX_TS |

### JSON Coverage

11 dedicated JSON test files covering all commands that support `--json`:

| File | Commands tested |
| --- | --- |
| `status-json` | status |
| `verify-json` | verify |
| `push-pull-json` | push, pull |
| `sync-json` | sync |
| `doctor-json` | doctor |
| `track-json` | track (single file, directory) |
| `config-json` | config (show all, get key) |
| `untrack-rm-json` | untrack, rm |
| `check-unpushed-json` | check-unpushed |
| `health-json` | health (success, failure) |
| `errors-json` | track error, push error, verify mismatch, status modified |

Commands without JSON support: `mv`, `hooks`, `pre-push-check`, `init`, `skill`,
`prime`.

* * *

## Deliverables

- **Coverage matrix:** `docs/project/specs/active/golden-test-coverage-matrix.md`
- **CI guardrail script:** `packages/blobsy/scripts/check-golden-coverage.sh`
- **49 golden test files** across 5 categories with 432 expectations

## Release Gate Checklist

- [x] All command help and JSON contracts are snapshot-covered
- [x] Zero unnamed wildcards suppressing deterministic blobsy output
- [x] Coverage matrix is complete for all shipped commands in CLI registration
- [x] CI guardrail script verifies no `...` elisions and all commands covered

## References

- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md)
- [blobsy-design.md](../../design/current/blobsy-design.md)
- [plan-2026-02-21-blobsy-phase1-implementation.md](plan-2026-02-21-blobsy-phase1-implementation.md)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md](plan-2026-02-21-blobsy-phase2-v1-completion.md)
- `tbd guidelines golden-testing-guidelines`
- `npx tryscript@latest docs`
