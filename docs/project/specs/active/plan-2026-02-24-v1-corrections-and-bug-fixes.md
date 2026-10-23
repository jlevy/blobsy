# Feature: V1 Corrections and Bug Fixes

**Date:** 2026-02-24

**Author:** Joshua Levy with LLM assistance

**Status:** Draft

## Overview

Systematic corrections for design errors, implementation bugs, and missing golden test
coverage discovered during QA of the blobsy v1 CLI. The primary finding is that
`blobsy add` fails on files inside gitignored directories because git refuses to add
blobsy-managed files (`.bref`, `.gitignore`) that inherit a parent gitignore rule.
Deeper investigation revealed several related issues across `add`, `track`, `mv`,
`untrack`, and `rm` commands.

## Goals

- Fix all commands so gitignored files can be managed by blobsy (its core purpose)
- Automatically correct `.gitignore` rules to allow `.bref` and `.gitignore` files when
  tracking inside gitignored directories — only when necessary, not proactively
- Wrap all raw `git` subprocess calls with user-friendly error handling
- Make `mv`, `untrack`, and `rm` stage their changes to git (consistent with `add`)
- Remove or implement dead `--force` flags
- Add golden tests for every fixed workflow

## Non-Goals

- Major new features or architectural changes
- Changes to the backend/push/pull layer (those commands don’t interact with `git add`)
- Performance optimization

## Background

Blobsy’s core purpose is managing large files outside of git.
A typical workflow is: users gitignore a directory of large files, then use `blobsy add`
to track them with `.bref` pointers.
However, when the directory is already in `.gitignore`, blobsy’s `git add` call on the
`.bref` and `.gitignore` files it creates fails because those files inherit the parent
gitignore rule.

Systematic review revealed this is one of several related issues where blobsy commands
create or modify files (`.bref`, `.gitignore`) but don’t properly stage them to git, or
don’t handle the gitignore inheritance case.

### Reproducer (original bug)

```bash
# In a repo where research/explorations/ is gitignored:
blobsy add sec-cache-15
# Output:
# Scanning .../sec-cache-15/...
# 0 files tracked.
# Error: Command failed: git add -- .../blobs/file1.json .../blobs/file2.json ...
# The following paths are ignored by one of your .gitignore files:
#   research/explorations/...
# hint: Use -f if you really want to add them.
```

### Git behavior with gitignored files: systematic test results

#### Part 1: Does the gitignore pattern affect blobsy-managed files?

We tested `git add` of `.bref` and `.gitignore` files created by blobsy across every
gitignore pattern variant.
Setup: `data/sub/file.json` (blob), `data/sub/file.json.bref`, `data/sub/.gitignore`.

**A. No gitignore affecting path — no issue**

| Scenario | Exit | `.bref` staged? | `.gitignore` staged? |
| --- | --- | --- | --- |
| No gitignore at all | 0 | Yes | Yes |

**B. Selective gitignore (files/extensions, not whole directory) — no issue**

| Pattern | Exit | `.bref` staged? | Blob ignored? |
| --- | --- | --- | --- |
| `*.json` | 0 | Yes | Yes |
| `data/**/*.json` | 0 | Yes | Yes |
| `data/sub/file.json` | 0 | Yes | Yes |

Selective patterns only match the blob files themselves, not `.bref` files (different
extension). No gitignore rewriting needed for these cases.

**C. Whole directory ignored — BROKEN, blocks all blobsy files**

| Pattern | Exit | `.bref` staged? | Notes |
| --- | --- | --- | --- |
| `data/` | 1 | No | Directory pattern, blocks all negation |
| `data` (no slash) | 1 | No | Matches directory too |
| `data/**` | 1 | No | Glob, same blocking behavior |
| `**/data/` | 1 | No | Recursive directory match |
| `/data/` | 1 | No | Rooted directory match |

**D. Nested: parent of parent is ignored — BROKEN, same issue**

| Pattern | Exit | `.bref` staged? |
| --- | --- | --- |
| `research/explorations/` (bref is 3 levels deep) | 1 | No |

#### Part 2: Why `--force` is not a viable fix

| Operation (with `data/` pattern) | No `--force` | With `--force` |
| --- | --- | --- |
| Initial add of new `.bref` | exit 1, NOT staged | exit 0, staged |
| Modify already-tracked `.bref` | exit 1, staged (misleading) | exit 0, staged |
| Add second new `.bref` | exit 1, NOT staged | exit 0, staged |
| Add nested `.gitignore` | exit 1, NOT staged | exit 0, staged |

`--force` must be used on **every** `git add`, not just the first time.
New `.bref` files always need `--force`. Already-tracked files appear to stage (despite
exit 1), but `execFileSync` throws on non-zero exit, so blobsy would crash.
This makes `--force` impractical as a permanent solution.

#### Part 3: Rewrite verification

Replacing the directory pattern with `<pattern>/**` + `!<pattern>/**/` + `!**/*.bref` +
`!**/.gitignore` fixes every failing case:

| Original pattern | Rewritten to | `.bref` staged? | Blob still ignored? |
| --- | --- | --- | --- |
| `data/` | `data/**` + negations | Yes (exit 0) | Yes |
| `data` (no slash) | `data/**` + negations | Yes (exit 0) | Yes |
| `data/**` | add negations only | Yes (exit 0) | Yes |
| `**/data/` | `**/data/**` + negations | Yes (exit 0) | Yes |
| `/data/` | `/data/**` + negations | Yes (exit 0) | Yes |
| `research/explorations/` | `research/explorations/**` + negations | Yes (exit 0) | Yes |

#### Part 4: Blobsy input mode vs gitignore scenario matrix

Blobsy accepts two input modes: explicit file (`blobsy add file.txt`) or directory
(`blobsy add data/`). The gitignore issue affects both modes identically — the problem
is at git staging time, not file discovery.

| Input mode | Gitignore scenario | File discovery | Git staging |
| --- | --- | --- | --- |
| Explicit file | A: No gitignore | Skipped (path given) | Works |
| Explicit file | B: Selective ignore | Skipped (path given) | Works (`.bref` not matched) |
| Explicit file | C: Directory ignored | Skipped (path given) | FAILS (exit 1) |
| Directory | A: No gitignore | `findTrackableFiles` (filesystem walk) | Works |
| Directory | B: Selective ignore | `findTrackableFiles` (filesystem walk) | Works (`.bref` not matched) |
| Directory | C: Directory ignored | `findTrackableFiles` (filesystem walk) | FAILS (exit 1) |

File discovery is not affected: `findTrackableFiles` uses `readdirSync`, not git, so it
finds files even in gitignored directories.
The failure is always at the `git add` step in `handleAdd` (`cli.ts:765`).

**Summary:** Gitignore rewriting is needed only for scenario C (whole directory
ignored). Scenarios A and B require no changes.
The rewrite handles all pattern variants (`dir/`, `dir`, `dir/**`, `**/dir/`, `/dir/`)
and works for both explicit-file and directory input modes.

## Design

### Issue 1: Gitignored directories block `blobsy add` (Critical Bug)

**Location:** `cli.ts:765`

`handleAdd` runs `git add -- ...` which fails when files are inside a gitignored
directory because `.bref` and `.gitignore` files inherit the parent ignore rule.

**Root cause:** Git has a hard rule: “It is not possible to re-include a file if a
parent directory of that file is excluded.”
A directory pattern like `data/` prevents **all** negation rules from working inside it.
Rewriting `data/` to `data/**` + `!data/**/` preserves the same ignore behavior while
allowing negation rules for specific file types.

**Fix — gitignore correction approach:**

When blobsy detects that files to be staged are gitignored, it should:

1. Use `git check-ignore -v` to identify which `.gitignore` file and rule is responsible
2. Rewrite the rule in the same `.gitignore` to an equivalent glob that allows negation:
   ```gitignore
   # Before (blocks all negation):
   data/

   # After (same ignore behavior, allows negation):
   # Directory ignore rewritten by blobsy to allow *.bref files
   data/**
   !data/**/
   !**/*.bref
   !**/.gitignore
   ```

**Key design constraint:** Only modify the `.gitignore` when we detect the conflict.
If files aren’t gitignored, don’t add reverse rules — avoid unnecessary gitignore noise.

### Issue 2: `mv` doesn’t stage anything (Critical Bug)

**Location:** `cli.ts:1459-1509`

`mvSingleFile` creates a new `.bref`, deletes the old `.bref`, and updates `.gitignore`
in both source and destination directories.
But it never runs `git add` or `git rm`.

After `blobsy mv old.bin new.bin`, `git status` shows untracked new `.bref` and deleted
old `.bref`, confusing users.

**Fix:** Collect files to stage in `mvSingleFile` and run
`git add <new .bref> <dest .gitignore> <src .gitignore>`. Also `git rm` the old `.bref`
if it was committed.

### Issue 3: `untrack`/`rm` don’t stage cleanup (Medium Bug)

**Locations:** `cli.ts:1173-1217` (`untrackFile`), `cli.ts:1256-1391` (`rmFile`)

Both commands remove `.gitignore` entries and move `.bref` to trash, but never stage the
resulting changes. If the `.bref` was previously committed, it remains in the git index
as a deleted file. The `.gitignore` modification is also unstaged.

**Fix:** After cleanup, stage the modified `.gitignore`. If the `.bref` was in the git
index, `git rm --cached` it.

### Issue 4: Raw git errors not caught (High)

**Locations:** `cli.ts:765`, `commands-stage2.ts:1532`

Both `execFileSync('git', ...)` calls have no try/catch.
On failure, raw Node.js errors propagate with cryptic messages.
Worse, `handleAdd` may have already created `.bref` files and modified `.gitignore`
before the staging step fails, leaving the repo in an inconsistent state.

**Fix:** Wrap in try/catch.
On `git add` failure, provide a clear error message and suggest next steps.

### Issue 5: `--force` flag is dead code on `add`/`track` (Low)

**Locations:** `cli.ts:134` (`add`), `cli.ts:145` (`track`)

Both commands declare `--force` ("Skip confirmation for destructive operations") but
neither `handleAdd` nor `handleTrack` reads `opts.force`. There are no confirmation
prompts in these commands.

**Fix:** Remove the `--force` option from both commands.
If `--force` is needed later (e.g., overwriting existing `.bref` for a different file),
it can be re-added with clear semantics.

### Issue 6: `track` doesn’t guide user on next steps (UX)

**Location:** `cli.ts:707-727`

After `blobsy track <file>`, the command prints tracking info but gives no guidance that
the user needs to `git add` the created `.bref` and `.gitignore` files.

**Fix:** Print a message like:

```
Files tracked. Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
```

### Issue 7: Symlinks silently skipped (Low)

**Location:** `paths.ts:129-158`

`walkDir` only handles `isFile()` and `isDirectory()`. Symlinks are silently skipped
with no warning.

**Fix:** Warn on symlinks when in verbose mode.
This is a low priority edge case.

## Implementation Plan

### Phase 1: Core git staging fixes

- [ ] Implement gitignore conflict detection and correction
  - Add `detectGitignoreConflict(filePaths, repoRoot)` utility that uses
    `git check-ignore -v` to find conflicts
  - Add `fixGitignoreForBlobsy(gitignorePath, rule)` that rewrites directory patterns to
    glob patterns with negation rules for `*.bref` and `.gitignore`
  - Call from `handleAdd` before `git add`, only when conflicts are detected
- [ ] Wrap git `execFileSync` calls in try/catch with user-friendly error messages
- [ ] Fix `mvSingleFile` to stage all created/modified files after move
- [ ] Fix `untrackFile` and `rmFile` to stage `.gitignore` changes and `git rm` old
  `.bref`
- [ ] Remove dead `--force` from `add` and `track` command definitions
- [ ] Add next-steps guidance to `track` command output
- [ ] Add golden tests for:
  - `blobsy add` on files in a gitignored directory (verifying gitignore correction)
  - `blobsy track` on files in a gitignored directory (and verify guidance message)
  - `blobsy mv` verifying files are staged
  - `blobsy untrack` verifying cleanup is staged
  - `blobsy rm` verifying cleanup is staged

### Phase 2: Semantic output coloring

- [ ] Add `--color <auto|always|never>` global option to Commander config
- [ ] Add semantic color map (`c`) to `format.ts` using picocolors
- [ ] Update all `format.ts` semantic helpers to apply colors (12 functions)
- [ ] Add new format helpers: `formatInfo`, `formatSuccess`, `formatCommand`,
  `formatNextSteps`
- [ ] Convert raw `console.log` strings in `cli.ts` to use semantic format helpers (~30
  call sites)
- [ ] Convert raw `console.log` strings in `commands-stage2.ts` to use semantic format
  helpers (~25 call sites)
- [ ] Move warning output from `console.log` to `console.error` where appropriate
- [ ] Add golden tests verifying clean (uncolored) output when piped

### Phase 3: Edge cases and polish (if needed)

- [ ] Warn on symlinks in verbose mode
- [ ] Review `sync --force` dead code (flag accepted but never checked)
- [ ] Audit any other `execFileSync` calls for missing error handling

## Testing Strategy

All behavior changes must be covered by golden tests (tryscript).
This is an unchanging rule: all behavior should be documented in golden tests.

**New golden test files:**

- `tests/golden/commands/add-gitignored.tryscript.md` — adding files inside a gitignored
  directory; verify that blobsy detects the conflict, rewrites the gitignore, and the
  `.bref` files are successfully staged
- `tests/golden/commands/track-gitignored.tryscript.md` — tracking files inside a
  gitignored directory
- `tests/golden/commands/mv-staging.tryscript.md` — verifying `mv` stages changes
- `tests/golden/commands/untrack-staging.tryscript.md` — verifying `untrack` stages
  cleanup
- `tests/golden/commands/rm-staging.tryscript.md` — verifying `rm` stages cleanup

Each test should set up a git repo with a gitignored directory, run the blobsy command,
and verify via `git status` that all expected files are properly staged.

Existing golden tests should continue to pass (regression).

### Issue 8: No semantic coloring in command output (UX)

**Problem:** All command output is plain uncolored text.
The `format.ts` module has good semantic structure (symbols, helpers) but no color
layer. Colors are only used in Commander help text styling (`cli.ts:18`), not in any
command output. When output is piped or redirected (non-TTY), it should remain clean
plain text with no ANSI escape codes.

**Current state:**

- `format.ts` — 17 semantic helpers produce plain strings, no color
- `cli.ts` — ~65 raw `console.log` calls with inline string formatting, no color
- `commands-stage2.ts` — ~50 raw `console.log` calls, some using format helpers, no
  color
- `picocolors` already imported in `cli.ts:18` but only used for help text
- picocolors auto-detects TTY: when `!stdout.isTTY` or `NO_COLOR` is set, all color
  functions become identity (`String`), producing clean text automatically

**Color scheme — semantic categories:**

| Category | Color | Used for |
| --- | --- | --- |
| `success` | `green` | ✓ symbols, “Created”, “Installed”, “Tracked”, completion messages |
| `error` | `red` | ✗ symbols, “Error:”, “FAILED”, hash mismatches |
| `warning` | `yellow` | ⚠ symbols, warnings, caution messages |
| `info` | `cyan` | ℹ symbols, status messages, progress ("Scanning…", “Initialized…”) |
| `command` | `bold` | CLI instructions (`blobsy track <file>`, `git commit`) |
| `heading` | `bold` | Section headings (`=== CONFIGURATION ===`) |
| `hint` | `dim` | Next-step suggestions, secondary guidance, “Run with --fix” |
| `muted` | `gray` | Secondary details, already-up-to-date, unchanged items |
| `data` | (none) | File paths, sizes, counts — default terminal color |

**Stderr separation (per tbd `typescript-cli-tool-rules`):**

| Output type | Destination | Notes |
| --- | --- | --- |
| Data results | stdout | Status, file lists, config values |
| Success messages | stdout | “Created”, “Tracked”, completion |
| Errors | stderr | Already correct for most `console.error` calls |
| Warnings | stderr | Move `console.log` warnings to `console.error` |
| Hints/tips | stdout | Next steps guidance |

Currently most warnings use `console.log` (e.g. `cli.ts:689`,
`commands-stage2.ts:1408`). These should move to `console.error`/`console.warn` so they
don’t pollute piped data.

**`--color` global flag (per tbd patterns):**

Add `--color <mode>` global option (`auto` | `always` | `never`) matching git/ls/grep
convention. Use `pc.createColors(enabled)` to override picocolors’ auto-detection, which
can misfire under `pnpm run` or CI runners.
Default is `auto` (existing picocolors behavior).

```typescript
// In cli.ts global options:
.option('--color <mode>', 'Colorize output (auto, always, never)', 'auto')

// Before command dispatch, override picocolors:
import { createColors } from 'picocolors';
const colorEnabled = opts.color === 'always' || (opts.color === 'auto' && isColorSupported);
const pc = createColors(colorEnabled);
```

**Fix — add color layer to `format.ts`:**

Import picocolors and add semantic color functions:

```typescript
import colors from 'picocolors';

// Semantic color wrappers
export const c = {
  success: colors.green,
  error: colors.red,
  warning: colors.yellow,
  info: colors.cyan,
  command: colors.bold,
  heading: colors.bold,
  hint: colors.dim,
  muted: colors.gray,
} as const;
```

**Changes to existing `format.ts` helpers:**

| Helper | Change |
| --- | --- |
| `formatCheckPass(msg)` | `c.success(OUTPUT_SYMBOLS.pass)` + msg |
| `formatCheckFail(msg)` | `c.error(OUTPUT_SYMBOLS.fail)` + msg |
| `formatCheckWarn(msg)` | `c.warning(OUTPUT_SYMBOLS.warn)` + msg |
| `formatCheckInfo(msg)` | `c.info(OUTPUT_SYMBOLS.info)` + msg |
| `formatCheckFixed(msg)` | `c.success(OUTPUT_SYMBOLS.pass + ' Fixed')` + msg |
| `formatHeading(name)` | `c.heading(...)` wrap whole string |
| `formatPushResult(path)` | `c.success(OUTPUT_SYMBOLS.push)` + path |
| `formatPullResult(path)` | `c.success(OUTPUT_SYMBOLS.pull)` + path |
| `formatTransferFail(path, err)` | `c.error(OUTPUT_SYMBOLS.fail)` + path + `c.error('FAILED: ' + err)` |
| `formatWarning(msg)` | `c.warning(OUTPUT_SYMBOLS.warn)` + msg |
| `formatHint(hint)` | `c.hint(hint)` |
| `formatError(err)` | `c.error('Error:')` + message, suggestions in `c.hint()` |

**New helpers to add to `format.ts`:**

```typescript
/** Format an info/status message with color. */
export function formatInfo(message: string): string;

/** Format a success/completion message with color. */
export function formatSuccess(message: string): string;

/** Format a CLI command reference with bold. */
export function formatCommand(command: string): string;

/** Format a "next steps" block: heading + indented command list. */
export function formatNextSteps(heading: string, steps: Array<{cmd: string, desc: string}>): string;
```

**Raw `console.log` calls to convert in `cli.ts`:**

| Lines | Current output | Convert to |
| --- | --- | --- |
| 459-464 | `'Setup complete! Next steps:\n  blobsy track...'` | `formatNextSteps()` |
| 508 | `` `Installed ${BLOBSY_SKILL_REL}` `` | `formatSuccess(...)` |
| 545, 554 | `` `Updated/Added blobsy section in ${AGENTS_MD_REL}` `` | `formatSuccess(...)` |
| 592-593 | `` `Created backend directory: ${path}` `` | `formatSuccess(...)` |
| 647-648 | `` `Initialized blobsy in...\nCreated .blobsy.yml` `` | `formatInfo(...)` |
| 672-674 | `'Hook manager detected...\n  pre-commit: blobsy hook...'` | `formatInfo()` + `formatCommand()` |
| 689-691 | `` `Existing hook found. Add manually: ...` `` | `formatWarning()` + `formatCommand()` |
| 702 | `` `Installed ${hook.name} hook.` `` | `formatSuccess(...)` |
| 784-786 | `` `Staged N files...\nChanges have been staged...` `` | `formatSuccess()` + `formatHint()` |
| 846 | `` `${relPath} already tracked (unchanged)` `` | `c.muted(...)` |
| 872 | `` `Updated ${refRelPath} (hash changed)` `` | `formatSuccess(...)` |
| 900-902 | `` `Tracking...\nCreated...\nAdded to .gitignore` `` | `formatSuccess(...)` each |
| 943 | `` `Scanning ${relDir}/...` `` | `formatInfo(...)` |
| 968 | `` `  ${path}  -> already tracked (unchanged)` `` | `c.muted(...)` |
| 982 | `` `  ${path}  -> updated (hash changed)` `` | `formatSuccess(...)` |
| 997 | `` `  ${path}  -> tracked` `` | `formatSuccess(...)` |
| 1016 | `` `${parts.join(', ')}.` `` | `formatSuccess(...)` |
| 1039 | `'No tracked files found.'` | `formatInfo(...)` |
| 1133 | `'Verification failed.'` | `c.error(...)` |
| 1136 | `'All files verified.'` | `formatSuccess(...)` |
| 1214-1215 | `` `Untracked...\nMoved to trash` `` | `formatSuccess(...)` each |
| 1288 | `` `Deleted local file: ${relPath}` `` | `formatSuccess(...)` |
| 1353 | `` `Deleted from backend: ${key}` `` | `formatSuccess(...)` |
| 1359-1361 | `` `Warning: Failed to delete...` `` | `formatWarning(...)` |
| 1366 | `'Note: File was never pushed...'` | `formatInfo(...)` |
| 1387-1389 | `` `Removed...\nMoved to trash\nDeleted local file` `` | `formatSuccess(...)` each |
| 1506 | `` `Moved ${src} -> ${dest}` `` | `formatSuccess(...)` |
| 1619, 1665, 1680 | Config info messages | `formatInfo(...)` |
| 1651 | `` `Unset ${key}` `` | `formatSuccess(...)` |
| 1682 | `'No .blobsy.yml found. Run: blobsy setup --auto <url>'` | `formatInfo()` + `formatCommand()` |
| 1765 | `` `Set ${key} = ${value}` `` | `formatSuccess(...)` |
| 1849 | `` `Error: ${message}` `` | `c.error(...)` |

**Raw `console.log` calls to convert in `commands-stage2.ts`:**

| Lines | Current output | Convert to |
| --- | --- | --- |
| 196, 297 | `'No tracked files to push/pull.'` | `formatInfo(...)` |
| 227 | `` `  ${path}  already pushed` `` | `c.muted(...)` |
| 271-272 | `` `Done: N pushed, N failed.` `` | `formatSuccess(...)` or mixed |
| 328 | `` `  ${path}  not pushed yet` `` | `formatInfo(...)` |
| 337 | `` `  ${path}  already up to date` `` | `c.muted(...)` |
| 370-371 | `` `Done: N pulled, N failed.` `` | `formatSuccess(...)` or mixed |
| 397 | `` `Health check failed: ${message}` `` | `c.error(...)` |
| 423 | `'Everything up to date.'` | `formatSuccess(...)` |
| 447, 462 | `` `  ↑/↓ ${path} - pushed/pulled` `` | Already uses `OUTPUT_SYMBOLS`, add color |
| 452, 467 | `` `  ✗ ${path} - failed: ${error}` `` | Already uses `OUTPUT_SYMBOLS`, add color |
| 487 | `` `  ↑ ${path} - pushed (modified)` `` | Add color via `c.success()` |
| 493 | `` `  ✓ ${path} - up to date` `` | Add color via `c.success()` |
| 501 | `` `Sync complete: N pushed, N pulled, N errors.` `` | `formatSuccess(...)` |
| 519 | `'Backend is reachable and writable.'` | `formatSuccess(...)` |
| 525 | `` `Health check failed: ${message}` `` | `c.error(...)` |
| 583 | `'No tracked files found.'` | `formatInfo(...)` |
| 992 | `'No issues found.'` | `formatSuccess(...)` |
| 997 | `` `N issues found. Run with --fix...` `` | `c.error(count)` + `c.hint('Run with --fix...')` |
| 1000 | `'All issues fixed.'` | `formatSuccess(...)` |
| 1418, 1433 | `` `Installed/Uninstalled hook.` `` | `formatSuccess(...)` |
| 1423 | `` `  Using executable: ${path}` `` | `formatInfo(...)` |
| 1437, 1441 | Hook info messages | `formatInfo(...)` |
| 1471 | `'All tracked files have been pushed.'` | `formatSuccess(...)` |
| 1476 | `` `N files not pushed.` `` | `c.error(...)` |
| 1515 | `'All refs have remote blobs. Safe to push.'` | `formatSuccess(...)` |
| 1520-1521 | `` `N files missing...Run blobsy push first.` `` | `c.error(count)` + `formatHint(...)` |
| 1560-1566 | Pre-commit error block | `c.error(...)` + `formatHint(...)` |
| 1586 | `` `blobsy pre-push: uploading N blobs...` `` | `formatInfo(...)` |
| 1607 | `'blobsy pre-push: all blobs uploaded.'` | `formatSuccess(...)` |

**JSON mode:** No change — `formatJson*` helpers produce structured data, never colored.
The `--json` / `--quiet` guards already skip human-readable output.

**TTY/pipe behavior (picocolors + `--color` flag):**

| Environment | Behavior |
| --- | --- |
| Interactive terminal (TTY) | Full color (`--color auto`, default) |
| Piped (`blobsy status \| grep`) | No ANSI codes, clean text |
| Redirected (`blobsy status > file`) | No ANSI codes, clean text |
| Agent/script consumption | No ANSI codes (non-TTY) |
| `NO_COLOR=1` | No ANSI codes (standard convention) |
| `FORCE_COLOR=1` / `--color always` | Colors even in pipe |
| `--color never` | No ANSI codes even on TTY |
| `--json` mode | No colors (JSON output path, unaffected) |

## Rollout Plan

Single release with all fixes.
Run full CI (`pnpm ci`) before merging.

## Open Questions

- Should `mv` behave more like `add` (stage everything) or more like `track` (don’t
  stage, just tell the user)?
  Initial recommendation: stage everything, consistent with `add`.
- When rewriting a gitignore rule, should blobsy add a comment explaining the change?
  e.g., `# Rewritten by blobsy to allow .bref tracking (was: data/)`

## References

- Original bug report: `blobsy add` on gitignored directory fails with `git add` error
- Git documentation on gitignore negation limitations: “It is not possible to re-include
  a file if a parent directory of that file is excluded.”
- Affected source files: `packages/blobsy/src/cli.ts`,
  `packages/blobsy/src/commands-stage2.ts`, `packages/blobsy/src/paths.ts`,
  `packages/blobsy/src/gitignore.ts`
