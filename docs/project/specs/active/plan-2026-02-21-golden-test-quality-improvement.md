# Feature: Golden Test Quality Improvement

**Date:** 2026-02-21

**Author:** AI Engineering Review

**Status:** Draft

## Overview

A systematic overhaul of the 39 existing tryscript golden tests to align them with the
golden testing philosophy established in
[blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) and
[golden-testing-guidelines](https://github.com/jlevy/tbd).
The current tests have a pervasive anti-pattern: most use `...` (multi-line elision) to
suppress command output rather than capturing it fully.
This defeats the core value proposition of golden testing -- broad behavioral visibility
through diffs.

## Goals

- Eliminate the `...` output suppression anti-pattern across all test files
- Capture full command output in every console block so behavioral changes surface as
  diffs
- Add filesystem inspection (`find`, `cat`) after all state-changing operations
- Verify JSON output structure in all `json/` tests (currently suppressed)
- Verify echo backend transport commands in all `echo-backend/` tests (currently
  suppressed)
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

The current tests violate these principles extensively.
Of the 39 test files, the majority suppress output with `...` elision, meaning changes
to blobsy’s output will not be caught.
The JSON tests -- which define the machine-readable API contract -- show zero JSON
structure. The echo backend tests -- whose purpose is transport-layer visibility -- hide
the transport commands.

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

## Findings

### Issue 1: Pervasive Output Suppression (P0)

**Affected files:** ~21 of 39 test files (about 71 `...` elisions remain)

The most common pattern across the test suite is:

```console
$ blobsy push
...
? 0
```

This captures nothing.
If `blobsy push` changes its output format, adds a warning, removes a status line, or
breaks entirely but still exits 0, this test passes unchanged.

The testing design doc’s example for the same command shows:

```console
$ blobsy push data/model.bin
Pushing 1 file...
  data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

Every output line is captured.
A format change becomes a visible diff.

**Files with extensive `...` suppression:**

- `commands/push-pull.tryscript.md` -- push/pull output fully suppressed
- `commands/sync.tryscript.md` -- sync output fully suppressed
- `commands/doctor.tryscript.md` -- doctor output fully suppressed
- `commands/health.tryscript.md` -- health output fully suppressed
- `commands/check-unpushed.tryscript.md` -- output fully suppressed
- `commands/pre-push-check.tryscript.md` -- output fully suppressed
- `workflows/fresh-setup.tryscript.md` -- all workflow output suppressed
- `workflows/modify-and-resync.tryscript.md` -- all output suppressed
- `workflows/two-user-conflict.tryscript.md` -- all output suppressed
- `workflows/compression.tryscript.md` -- all output suppressed
- `workflows/branch-workflow.tryscript.md` -- all output suppressed
- `workflows/multi-file-sync.tryscript.md` -- all output suppressed
- `workflows/doctor-fix.tryscript.md` -- all output suppressed
- `errors/conflict-errors.tryscript.md` -- error output suppressed
- `errors/partial-failure.tryscript.md` -- error output suppressed
- All 4 `echo-backend/` tests -- echo transport output suppressed

**Resolution:** Replace every `...` with the actual expected output, using `[HASH]`,
`[REMOTE_KEY]`, `[TIMESTAMP]`, `[..]`, and `[CWD]` patterns for genuinely unstable
fields. Run `tryscript run --update` to capture actual output, then review and commit.

### Issue 2: JSON Coverage Breadth Is Still Limited (P1)

**Current status:** The dedicated files in `tests/golden/json/` now capture concrete
JSON output (good improvement).

**Remaining gap:** JSON coverage is still limited to a subset of commands and mostly
success paths. Error-path schema coverage and simple-message command JSON coverage are
still incomplete.

**Resolution:** Keep strict full-JSON snapshots for the existing files, and extend JSON
coverage across the full command surface and error categories (see Issue 24 and Issue
29).

### Issue 3: Echo Backend Tests Hide Transport Commands (P0)

**Affected files:** All 4 files in `echo-backend/`

- `echo-backend/push-commands.tryscript.md`
- `echo-backend/pull-commands.tryscript.md`
- `echo-backend/sync-commands.tryscript.md`
- `echo-backend/compression-commands.tryscript.md`

The entire purpose of the echo backend is transport-layer visibility.
The testing design doc says:

> By configuring a command backend that echos its transport calls, the golden test
> output includes the exact backend operations blobsy performed.

Yet the tests suppress the `PUSH ...` and `PULL ...` echo lines.
If blobsy changes how it constructs backend commands (wrong bucket, wrong key format,
wrong local path), these tests won’t catch it.

**Resolution:** Show the echo output (`PUSH` / `PULL` lines) in full, with `[TMPFILE]`
and `[REMOTE_KEY]` patterns for unstable fields.
Also show the `find .mock-remote/` listing after push to verify remote state.

### Issue 4: Missing Filesystem Inspections (P2)

**Affected files:** Most test files

The testing design doc prescribes:

```bash
$ find . -not -path './.git/*' -not -name '.git' | sort
```

after state-changing operations.
Many tests skip this entirely or only use surgical checks (`test -f`, `grep`).

Specific gaps:

- `commands/push-pull.tryscript.md` -- no filesystem listing after push showing remote
  blobs. No `cat` of `.yref` to show `remote_key` was set.
- `commands/sync.tryscript.md` -- no filesystem inspection at all
- `commands/status.tryscript.md` -- no filesystem inspection (status is read-only, but
  the before block creates state that should be verified)
- `commands/untrack.tryscript.md` -- no verification of `.gitignore` after untrack
- `commands/rm.tryscript.md` -- no verification of `.gitignore` after rm
- `workflows/*` -- most workflows skip remote store listing (`find remote/ -type f`)

**Resolution:** Add `find` and `cat` commands after every state-changing operation, per
the testing design doc convention.
At minimum: filesystem listing after track, push, pull, untrack, rm, mv, doctor --fix.
Remote store listing (`find remote/ -type f | sort` or
`find .mock-remote/ -type f | sort`) after every push.

### Issue 5: Status Test Missing Key States (P1)

**Affected file:** `commands/status.tryscript.md`

The design spec defines 7 state symbols: `○`, `◐`, `◑`, `✓`, `~`, `?`, `⊗`. The status
test only exercises: `○` (not committed, not synced) and `~` (modified).

Missing states:

- `◐` (committed, not synced) -- requires commit then check status before push
- `◑` (not committed, synced) -- requires push before commit
- `✓` (committed and synced) -- requires push + commit
- `?` (missing) -- requires deleting a tracked file
- `⊗` (staged for deletion) -- requires `blobsy rm` then check status

The spec notes that `◑` and `✓` are tested in `json/status-json.tryscript.md`, but that
file suppresses all output.
Even so, the per-command status test should exercise the full state lifecycle with human
output.

**Resolution:** Extend `commands/status.tryscript.md` to walk through the full state
lifecycle: track (`○`) -> commit (`◐`) -> push (`◑`) -> commit push (`✓`) -> modify
(`~`) -> delete (`?`) -> rm (`⊗`). Show full status output at each step.

### Issue 6: Conflict Testing Is Incomplete (P1)

**Affected files:**

- `errors/conflict-errors.tryscript.md`
- `workflows/two-user-conflict.tryscript.md`

`conflict-errors.tryscript.md` is misnamed -- it tests pull behavior but not actual
conflict detection. It suppresses output with `...` so even the behaviors it does test
are not captured.

`two-user-conflict.tryscript.md` does not actually simulate the critical conflict
scenario: two independent modifications where the stat cache detects a three-way
disagreement (local hash != ref hash != cache hash).
It only tests a force-push scenario.

The design spec’s three-way merge table has 7 cases:

| Local | .yref | Cache | Action |
| --- | --- | --- | --- |
| A | A | A | Up to date |
| A | A | (none) | Create cache entry |
| A | B | A | Pull (git pull updated .yref) |
| B | A | A | Push (user modified file) |
| B | B | A | Up to date (both changed same way) |
| B | C | A | **Conflict** |
| B | A | (none) | **Error** (ambiguous) |

The conflict tests should exercise at least: pull refuses modified local (exit 2), push
refuses hash mismatch, sync detects three-way conflict, `--force` override for both push
and pull.

**Resolution:**

- Rewrite `errors/conflict-errors.tryscript.md` to test: pull refuses modified local
  (full error output), push refuses post-track modification (full error output),
  `--force` overrides.
- Rewrite `workflows/two-user-conflict.tryscript.md` to simulate stat-cache-based
  conflict: set up synced state, modify local file, simulate git-pull updating .yref
  (write new .yref manually), run `blobsy sync` and capture the full conflict error.

### Issue 7: Help Test Missing Commands (P1)

**Affected file:** `commands/help.tryscript.md`

The help test covers `--help` for: top-level, track, push, pull, status, sync, verify,
rm, doctor.

Missing `--help` for: init, untrack, mv, config, hooks, health, check-unpushed,
pre-push-check, trust.
That is 9 commands whose help text is not golden-tested.
If their help text changes or breaks, CI won’t catch it.

**Resolution:** Add `--help` blocks for every missing command.

### Issue 8: Doctor Tests Are Minimal (P1)

**Affected files:**

- `commands/doctor.tryscript.md`
- `workflows/doctor-fix.tryscript.md`

Both tests only exercise one diagnostic scenario (missing gitignore entry) and suppress
all output. The design spec lists many doctor checks:

- Missing `.gitignore` entries
- Orphaned `.gitignore` entries
- Invalid `.yref` files (malformed YAML, unsupported format)
- Stale stat cache entries
- Missing pre-commit hook
- Orphaned `.blobsy-tmp-*` temp files
- Connectivity check

**Resolution:** Expand the doctor tests to:

1. Show full doctor output for a healthy repo
2. Test each detectable issue type individually
3. Test `--fix` for each fixable issue
4. Verify the fix worked (run doctor again)
5. Show full output at every step (no `...`)

### Issue 9: Config Test Missing Set Operation (P2)

**Affected file:** `commands/config.tryscript.md`

The test only reads config values.
The design spec says `blobsy config [key] [value]` supports get/set, but no set
operation is tested.

**Resolution:** Add tests for setting config values and verifying the change persists.

### Issue 10: Init Test Missing Error Cases (P2)

**Affected file:** `commands/init.tryscript.md`

Only tests: local backend init, idempotent re-init, missing URL error, unrecognized
scheme error, invalid S3 bucket name error.

Missing:

- Init with S3 URL (to verify config shape)
- Init with GCS URL
- Init with Azure URL
- Init with `--region` and `--endpoint` flags
- Init outside a git repository (should fail)
- Init with local backend path inside repo (should fail per design -- local path must
  resolve outside)

**Resolution:** Add the missing URL scheme tests (config shape verification) and error
cases.

### Issue 11: Push-Pull Test Missing Key Scenarios (P1)

**Affected file:** `commands/push-pull.tryscript.md`

Missing scenarios:

- Push with uncommitted refs (warning message) -- the testing design doc shows this
  explicitly
- Pull when local file is modified (exit code 2, error message)
- Pull `--force` overwriting local modifications
- Push `--force` re-tracking and pushing
- Inspection of `.yref` after push showing `remote_key` field
- Remote store listing after push

**Resolution:** Add the missing scenarios with full output capture.
Show `.yref` content after push to verify `remote_key` is set.
Show `find remote/ -type f | sort` after push to verify blob placement.

### Issue 12: Sync Test Missing Key Scenarios (P1)

**Affected file:** `commands/sync.tryscript.md`

Missing scenarios:

- Sync with health check failure (backend unreachable)
- Sync detecting conflict (three-way merge disagreement)
- Sync with partial failure
- Sync with `--skip-health-check`
- Sync output showing per-file actions (pushed, pulled, up to date)

**Resolution:** Expand with full output capture for each sync mode.

### Issue 13: Validation Errors Missing Design Spec Cases (P2)

**Affected file:** `errors/validation-errors.tryscript.md`

The testing design doc shows explicit tests for:

- Malformed `.yref` file (invalid YAML)
- Unsupported format version (major mismatch)

Neither is in the current test.
The test only covers: track nonexistent file, untrack nonexistent file, rm nonexistent
file, init errors.

**Resolution:** Add tests for malformed `.yref` and unsupported format version, matching
the testing design doc examples.

### Issue 14: Not-Found Errors Missing Pull Scenario (P2)

**Affected file:** `errors/not-found-errors.tryscript.md`

Missing: pull when remote blob doesn’t exist (the `.yref` has a `remote_key` but the
blob is missing from the remote store).
This is a critical error path -- it’s what happens when someone commits a `.yref`
without pushing.

**Resolution:** Add a test that sets `remote_key` in a `.yref` but doesn’t actually push
the blob, then attempts to pull.

### Issue 15: Hooks Test Missing Execution Test (P2)

**Affected file:** `commands/hooks.tryscript.md`

The test installs and uninstalls hooks and checks the file exists, but never tests the
hook actually running during a `git commit`. The design spec says the pre-commit hook
auto-pushes blobs when committing `.yref` files.

**Resolution:** Add a test that:

1. Initializes a repo with hooks installed
2. Tracks and stages a file
3. Runs `git commit`
4. Verifies the hook pushed the blob (check remote store)

Note: this may need `BLOBSY_NO_HOOKS` unset, which conflicts with the shared config.
May need a per-file `env` override.

### Issue 16: Trust Test Is Surgical (P2)

**Affected file:** `commands/trust.tryscript.md`

Uses `wc -l` to count output lines rather than showing the actual output.
The trust command’s messages, format, and error handling are not captured.

**Resolution:** Show full output for trust, trust --list, trust --revoke.

### Issue 17: Quiet/Dry-Run Tests Incomplete (P3)

**Affected files:**

- `commands/quiet.tryscript.md` -- only tests `--quiet` with status, not with mutating
  operations (track, push, pull, sync)
- `commands/dry-run.tryscript.md` -- only tests `--dry-run` with track, not with push,
  pull, sync, rm, mv

**Resolution:** Add `--quiet` and `--dry-run` tests for mutating operations.

### Issue 18: Missing Compression Edge Cases (P3)

**Affected files:**

- `workflows/compression.tryscript.md`
- `echo-backend/compression-commands.tryscript.md`

Neither tests:

- Different compression algorithms (gzip, brotli) -- only zstd
- Compression with `never` patterns (e.g., `.parquet` should skip compression)
- Compression with small files below `min_size` threshold

**Resolution:** Add compression algorithm variation tests and edge cases.

### Issue 19: Workflow Tests Need Remote State Verification (P2)

**Affected files:** All `workflows/` files

None of the workflow tests inspect the remote store after push operations.
The testing design doc says:

> The remote listing (`find remote/` or `find .mock-remote/`) is particularly valuable
> after push/pull operations.

**Resolution:** Add `find remote/ -type f | sort` or `find .mock-remote/ -type f | sort`
after every push in workflow tests.

### Issue 20: Missing Test for Externalization Rules (P2)

No existing golden test exercises the full externalization rule logic for directory
tracking: `min_size` threshold, `always` patterns, `never` patterns, `ignore` patterns.
The `track.tryscript.md` test tracks directories but only with files that match the
`always` pattern by extension.

**Resolution:** Add a scenario (in `commands/track.tryscript.md` or as a new file) that
sets up files of varying sizes and types, configures explicit externalization rules,
runs `blobsy track <dir>`, and shows which files were externalized vs.
kept in git.

## Additional Findings (Second Senior Review)

### Issue 21: Malformed Command Blocks in `track` Test (P0)

**Affected file:** `commands/track.tryscript.md`

Several blocks accidentally merged multiple commands into one shell line (for example:
`echo ... > data/model.bin blobsy track ...`). This means the test labels claim behavior
that is not actually being exercised.
In practice this turns a “re-track” scenario into a plain `echo` redirection.

**Resolution:** Split merged commands into separate `$` lines, regenerate expected
output, and verify the intended scenario semantics (especially hash/size updates and
directory tracking behavior).

### Issue 22: Harness-Level Backend Override Masks Backend Resolution (P1)

**Affected file:** `packages/blobsy/tryscript.config.ts`

The suite-wide `BLOBSY_BACKEND_URL` override means most tests are not exercising backend
selection from `.blobsy.yml`. This makes backend resolution behavior effectively
untested except in files that manually clear the variable.

**Resolution:** Use backend override only in tests that explicitly validate env override
behavior.
All other tests should resolve backend through `.blobsy.yml` so config behavior
is actually tested.

### Issue 23: Shared Suite-Wide Remote Reduces Determinism (P1)

**Affected file:** `packages/blobsy/tryscript.config.ts`

A shared remote directory across all test files creates cross-test coupling.
This is one root cause of weak assertions (`...`, `wc -l`) in remote-inspection steps.

**Resolution:** Isolate remote state per test file (or per scenario) so full remote
listing assertions become stable and strict.

### Issue 24: JSON Coverage Is Incomplete Across Command Surface (P1)

Current JSON tests only cover `status`, `verify`, `push/pull`, `sync`, and `doctor`. But
the design contract says all commands support `--json`. The simple-schema commands
(`track`, `mv`, `untrack`, `rm`, `config`, `health`, `hooks`, `check-unpushed`,
`pre-push-check`, `trust`) need JSON golden coverage too.

**Resolution:** Add a JSON contract pass for all remaining commands (success and at
least one error case each).

### Issue 25: Missing Golden Tests for Shipped Commands (P1)

`blobsy skill` and `blobsy prime` are present in CLI command registration but have no
golden tests. This leaves agent-facing command output unversioned.

**Resolution:** Add `commands/skill.tryscript.md` and `commands/prime.tryscript.md`, and
include both in `help.tryscript.md` per-command help coverage.

### Issue 26: Trust Security Path Not Tested End-to-End (P1)

Echo backend tests use `BLOBSY_TRUST_ALL=1`, and `commands/trust.tryscript.md` only
tests list/trust/revoke output.
There is no test that command backend execution is blocked when untrusted, and allowed
after trust.

**Resolution:** Add a dedicated security workflow:
1. untrusted repo + command backend -> refusal,
2. `blobsy trust` -> allowed,
3. `blobsy trust --revoke` -> refusal restored.

### Issue 27: Global Flag Matrix Is Incomplete (P2)

`--verbose` has no positive behavior golden tests.
`--json`+error shape coverage is sparse outside the existing five JSON files.
`--force` and `--skip-health-check` are not exercised in a matrix style.

**Resolution:** Add a global-flag matrix test suite covering: `--json`, `--verbose`,
`--quiet`, `--dry-run`, `--force`, `--skip-health-check`, and invalid flag combinations.

### Issue 28: Path Form and Scope Matrix Is Incomplete (P2)

Only a subset of commands exercise both path forms (`file` vs `file.yref`) and scopes
(`file`, `directory`, `all`). This is a high-regression area in CLI path normalization.

**Resolution:** Add an explicit path normalization matrix for mutating and read
commands.

### Issue 29: Failure-Path JSON Assertions Are Missing (P2)

Even where human-readable errors are tested, equivalent JSON error objects are not
consistently covered.
This risks breaking machine consumers while human output still looks fine.

**Resolution:** Add JSON-mode error tests for validation, conflict, not-found,
permission, auth, and network categories.

### Issue 30: No Guardrail for Coverage Drift (P2)

There is no machine-checkable mapping from command inventory -> required golden
scenarios. As commands evolve, test completeness can silently regress.

**Resolution:** Add a maintained coverage matrix artifact plus a CI check that fails
when command/scenario entries are missing.

## Sequencing Relative to Phase 1 and Phase 2 Specs

### Immediate: Phase 1 Correction Sprint (Now)

These are corrections to Phase 1 deliverables and should happen before further feature
work:

- [ ] Fix Issue 21 (malformed command blocks)
- [ ] Complete Issue 1 + Issue 2 + Issue 3 (remove `...` from P0 files)
- [ ] Begin Issue 4 (filesystem inspection standards)
- [ ] Implement Issue 22 + Issue 23 (harness determinism and backend resolution
  fidelity)

### Phase 2 Stage 1 Alignment (CLI Polish)

As `--dry-run`, quiet semantics, and error text are finalized:

- [ ] Issue 17 global polish tests (quiet/dry-run)
- [ ] Issue 27 global flag matrix
- [ ] Issue 29 JSON error-path coverage for CLI-polish errors
- [ ] Refresh snapshots affected by error quality pass from
  `plan-2026-02-21-blobsy-phase2-v1-completion.md`

### Phase 2 Stage 2 Alignment (S3 Backend + Trust)

As trust and backend logic evolve:

- [ ] Issue 26 trust enforcement workflow tests
- [ ] Issue 22 backend resolution tests (including explicit env override behavior)
- [ ] Add S3/trust-specific golden scenarios planned in Phase 2 Stage 2

### Phase 2 Stage 3 Alignment (E2E / MinIO)

- [ ] Extend error golden coverage for auth/permission/network using MinIO-backed
  scenarios
- [ ] Expand sync partial-failure and conflict scenarios under realistic backend
  conditions

### Phase 2 Stage 4 Alignment (Docs + Agent Integration)

- [ ] Issue 25 add `skill`/`prime` command goldens
- [ ] Issue 7 complete per-command help snapshots including newly shipped commands
- [ ] Validate agent-facing output stability in markdown-heavy commands

### Phase 2 Stage 5 Alignment (Release Readiness)

- [ ] Issue 30 command-to-scenario coverage matrix and CI guardrail
- [ ] Final golden baseline update and diff review before publishing

## Updated Implementation Plan

### Track A: Signal Restoration (P0/P1, do first)

- [ ] Remove high-risk output elisions (`...`) from all P0 files
- [ ] Replace line-count/surgical checks with full output where practical
- [ ] Fix malformed command blocks and rerun impacted tests
- [ ] Stabilize harness to allow strict output assertions

### Track B: Scenario Completeness (P1/P2)

- [ ] Complete missing command-state scenarios (`status`, `sync`, `push/pull`, `doctor`)
- [ ] Add missing command coverage (`skill`, `prime`, trust enforcement)
- [ ] Add JSON contract coverage across the full command surface
- [ ] Add path/scoping matrix and global-flag matrix

### Track C: Governance and Drift Prevention (P2)

- [ ] Add coverage matrix doc (`command x scenario x output mode`)
- [ ] Add CI check to detect missing entries as command inventory changes
- [ ] Enforce a rule: any CLI output or option change requires golden review/update

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
- [ ] Coverage matrix is complete for all shipped commands in CLI registration

## References

- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md)
- [blobsy-design.md](../../design/current/blobsy-design.md)
- [plan-2026-02-21-blobsy-phase1-implementation.md](plan-2026-02-21-blobsy-phase1-implementation.md)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md](plan-2026-02-21-blobsy-phase2-v1-completion.md)
- `tbd guidelines golden-testing-guidelines`
- `npx tryscript@latest docs`
