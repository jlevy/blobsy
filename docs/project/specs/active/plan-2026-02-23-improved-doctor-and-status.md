# Feature: Improved Doctor and Status Commands

**Date:** 2026-02-23

**Author:** Joshua Levy with LLM assistance

**Status:** Implemented (2026-02-24)

**Reviewer:** Senior engineering review (automated)

## Overview

The `blobsy doctor` and `blobsy status` commands are the two primary diagnostic surfaces
for users. Today they are disjoint — `status` shows per-file sync states and `doctor`
checks structural health — but they should form a layered pair where doctor is a strict
superset of status. This spec upgrades both commands to match the vision in the design
doc (`blobsy-design.md` lines 1741-1938), closing gaps found during a senior engineering
review.

**Relationship:**

```
blobsy status    = per-file sync states (like git status)
blobsy doctor    = status + config validation + backend health + git hooks +
                   .bref integrity + stat cache + actionable advice
blobsy doctor -v = everything above with pass/fail detail for each check
```

## Goals

- Make `blobsy status` show per-state summary counts and file sizes (matching the design
  doc’s output format)
- Make `blobsy doctor` a superset of `blobsy status`: it should include file states at
  the top, then run all diagnostic checks below
- Add severity levels (error / warning / info) so users can distinguish critical
  problems from cosmetic ones
- Add missing diagnostic checks identified in the review:
  - Configuration validation (parseable sizes, valid algorithms, valid backend refs)
  - Git hook presence and validity
  - Backend tool availability (aws CLI, command binaries)
  - Fix the `CommandBackend.healthCheck()` no-op
  - `.bref` integrity (malformed YAML, wrong format version)
  - Stat cache health (corrupt entries, stale entries)
  - `.blobsy/` gitignored check
  - Dangling `.gitignore` entries
- Make `--verbose` show passing checks (not just failures)
- Implement proper error boundaries so one failing check doesn’t crash the rest
- Add `--fix` support for new fixable issues (install missing hooks, clean stale cache,
  remove dangling `.gitignore` entries)
- Consolidate all CLI output through semantic formatting helpers in `format.ts` so that
  headings, status lines, check results, warnings, and summaries are inherently
  consistent across every command — not just doctor/status
- Update the design doc to reflect the implemented behavior
- Add comprehensive golden session tests for all new checks

## Non-Goals

- Implementing `blobsy stats` as a separate command (doctor subsumes it)
- Remote blob existence verification (that’s `pre-push-check`, not doctor)
- Full `.gitignore` parsing (we check blobsy-managed blocks only)
- Network timeout configuration (use existing defaults)
- Changing exit code semantics beyond what the design doc specifies
- Color/ANSI formatting (that was Phase 5 of the polish spec; the helpers here are
  color-agnostic and will compose with `picocolors` when added later)
- An `OutputManager` class or output buffering abstraction — the helpers are plain
  functions that return strings, keeping things simple

## Background

The review identified these categories of gaps:

1. **P0 — Bugs/critical gaps:** `CommandBackend.healthCheck()` is a no-op (reports “No
   issues found” even when the command binary doesn’t exist); malformed `.bref` files
   crash doctor instead of being reported; no git hook checks at all.

2. **P1 — High-value improvements:** Doctor doesn’t include status output; no config
   validation; no aws CLI availability check; no severity levels.

3. **P2 — Nice to have:** Dangling `.gitignore` entries; stale stat cache cleanup;
   verbose mode; file sizes in status; backend type reporting in doctor.

4. **P1 — Output formatting inconsistency:** An audit of all `console.log`/
   `console.error` calls found that `format.ts` provides helpers but most commands
   bypass them: status uses inline template literals instead of `formatFileState()`;
   push/pull/sync each format transfer results differently (push uses
   `path (size) - pushed`, sync uses `↑ path - pushed`); doctor uses inline `✓`/`✗`;
   hooks use emoji `⚠️` where doctor proposes plain `⚠`; pluralization (`file`/`files`)
   is done via manual ternaries in 10+ places.
   The new doctor output (section headings, check results, severity markers) would just
   add more inconsistency unless we first consolidate formatting through semantic
   helpers.

## Design

### Issue Severity Model

Add a `severity` field to the existing issue model:

```typescript
type IssueSeverity = 'error' | 'warning' | 'info';

interface DoctorIssue {
  type: string;           // 'config' | 'backend' | 'gitignore' | 'hook' | 'bref' |
                          // 'directory' | 'orphan' | 'cache'
  severity: IssueSeverity;
  message: string;
  fixed: boolean;
  fixable: boolean;       // whether --fix can address it
}
```

Exit codes:
- `0` — No errors (warnings and info-only are OK)
- `1` — Errors detected (only `severity === 'error'` causes exit 1)

### Status Output Changes

**Current:**

```
  ✓  data/model.bin  synced
  ○  data/new.bin  not pushed

2 tracked files
```

**Proposed:**

```
  ✓  data/model.bin   synced    (1.2 MB)
  ○  data/new.bin     not pushed (500 KB)
  ~  data/draft.bin   modified  (3.1 MB)

3 tracked files: 1 synced, 1 new, 1 modified
```

Changes:
- File sizes from `.bref` metadata (human-readable, offline)
- Summary line shows counts per state

**JSON output adds per-state counts:**

```json
{
  "schema_version": "0.1",
  "files": [
    { "path": "data/model.bin", "state": "synced", "details": "synced", "size": 1258291 }
  ],
  "summary": {
    "total": 3,
    "synced": 1,
    "new": 1,
    "modified": 1
  }
}
```

### Doctor Output Changes

**Proposed output (healthy repo):**

```
$ blobsy doctor

  ✓  data/model.bin   synced    (1.2 MB)
  ○  data/new.bin     not pushed (500 KB)

2 tracked files: 1 synced, 1 new

=== CONFIGURATION ===
  ✓  .blobsy.yml valid
  ✓  Backend: local:../remote (local)
  ✓  Compression: zstd (threshold: 100 KB)
  ✓  Externalization threshold: 1 MB

=== GIT HOOKS ===
  ✓  pre-commit hook installed
  ✓  pre-push hook installed

=== BACKEND ===
  ✓  Backend reachable and writable

=== INTEGRITY ===
  ✓  All .bref files valid
  ✓  All .gitignore entries present
  ✓  .blobsy/ directory exists

No issues found.
```

**Proposed output (problems detected):**

```
$ blobsy doctor

  ✓  data/model.bin   synced    (1.2 MB)
  ?  data/orphan.bin  file missing

2 tracked files: 1 synced, 1 missing

=== CONFIGURATION ===
  ✓  .blobsy.yml valid
  ✓  Backend: local:../remote (local)

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed
     Run 'blobsy hooks install' to install hooks.

=== BACKEND ===
  ✓  Backend reachable and writable

=== INTEGRITY ===
  ✗  data/orphan.bin: .bref exists but local file missing and no remote_key
  ✗  data/model.bin: missing from .gitignore

3 issues found (2 errors, 1 warning). Run with --fix to attempt repairs.
```

**Verbose mode** (`blobsy doctor --verbose`) shows all checks including passing ones,
plus additional detail:

```
=== CONFIGURATION ===
  ✓  .blobsy.yml valid (repo: .blobsy.yml)
  ✓  Global config: not present
  ✓  Backend: local:../remote (local)
  ✓  Backend resolved via: config (backends.default)
  ✓  Compression: zstd (threshold: 100 KB)
  ✓  Externalization threshold: 1 MB
  ✓  Checksum algorithm: sha256

=== GIT HOOKS ===
  ✓  pre-commit hook installed (.git/hooks/pre-commit)
  ✓  pre-push hook installed (.git/hooks/pre-push)
  ✓  Hook content valid (contains 'blobsy hook')

=== BACKEND ===
  ✓  Backend reachable and writable

=== INTEGRITY ===
  ✓  2 .bref files valid YAML
  ✓  2 .bref files have supported format (blobsy-bref/0.1)
  ✓  2 .gitignore entries present
  ✓  0 dangling .gitignore entries
  ✓  .blobsy/ directory exists and writable
  ✓  Stat cache: 2 entries, 0 corrupt
```

Without `--verbose`, passing checks are suppressed.
If a category has no failures, the entire section (header included) is hidden.
If issues exist, the section header prints followed by only failing/warning/info checks.
The healthy-repo example above (lines 159-187) shows `--verbose` output for clarity —
without `--verbose`, a healthy repo shows only the status section and “No issues found.”

### Doctor Check Categories

The checks execute in this order.
Each category is wrapped in a try/catch so one failing category doesn’t prevent
subsequent categories from running.

#### 1. Status (file states)

Reuse the existing `getFileState()` logic from `handleStatus()`. Display the same
per-file output as `blobsy status` with sizes and summary counts.
This makes doctor a superset of status.

**Implementation:** Extract the file state computation into a shared function that both
`handleStatus()` and `handleDoctor()` call.

#### 2. Configuration Validation

| Check | Severity | Fixable | Notes |
| --- | --- | --- | --- |
| `.blobsy.yml` exists | error | no |  |
| `.blobsy.yml` valid YAML | error | no | Catch `loadConfigFile()` errors |
| Backend name resolves | error | no | `config.backend` points to existing `backends[name]` |
| Backend URL parseable | error | no | `parseBackendUrl()` doesn’t throw |
| `externalize.min_size` parseable | warning | no | `parseSize()` doesn’t throw |
| `compress.algorithm` valid | warning | no | One of: zstd, gzip, brotli, none |
| `compress.min_size` parseable | warning | no | `parseSize()` doesn’t throw |
| Global config valid (if present) | warning | no | `loadConfigFile(globalPath)` |
| Unknown top-level config keys | info | no | Detect typos like `compres:` |

#### 3. Git Hooks

| Check | Severity | Fixable | Notes |
| --- | --- | --- | --- |
| pre-commit hook exists | warning | yes | `--fix` runs `blobsy hooks install` |
| pre-push hook exists | warning | yes |  |
| Hook content contains `blobsy hook` | warning | no | Detect non-blobsy hooks (don’t overwrite) |
| Hook files executable | warning | yes | `--fix` sets `chmod +x` |

#### 4. Backend Health

| Check | Severity | Fixable | Notes |
| --- | --- | --- | --- |
| Backend tool available | warning | no | `isAwsCliAvailable()` for S3 (falls back to SDK); error for command backends |
| Backend reachable and writable | error | no | Existing `runHealthCheck()` |
| Command backend: fix no-op | — | — | `CommandBackend.healthCheck()` should check binary exists |

#### 5. Integrity

| Check | Severity | Fixable | Notes |
| --- | --- | --- | --- |
| `.blobsy/` directory exists | error | yes | Create with `--fix` (existing) |
| `.blobsy/` is writable | error | no | Test write to `.blobsy/` |
| `.blobsy/` in `.gitignore` | error | yes | Add entry with `--fix` |
| All `.bref` files valid YAML | error | no | Catch per-file, report each |
| All `.bref` format versions supported | warning | no | Check `format: blobsy-bref/0.1` |
| Missing `.gitignore` entries | error | yes | Existing check |
| Dangling `.gitignore` entries | warning | yes | Entries without corresponding `.bref` |
| Orphaned `.bref` (no local, no remote_key) | error | no | Existing check |
| Stat cache corrupt entries | warning | yes | `--fix` deletes corrupt entries |
| Stat cache stale entries | info | yes | `--fix` deletes stale entries |

### Output Formatting Consolidation

An audit of all `console.log`/`console.error` calls across the CLI reveals significant
inconsistency: `format.ts` provides helpers (`formatFileState`, `formatSize`,
`formatTransferSummary`, `formatError`, etc.)
but most commands bypass them and format inline.
This makes it impossible to guarantee visual consistency across commands.

**Problem inventory** (current state):

| Pattern | Example | Where Used | Problem |
| --- | --- | --- | --- |
| Status line | `  ✓  path  details` | `cli.ts` status, verify | Inline template literal, doesn’t use `formatFileState()` |
| Transfer result | `  path (size) - pushed` | `commands-stage2.ts` push/pull | Inline, differs from sync which uses `↑`/`↓` symbols |
| Sync result | `  ↑ path - pushed` | `commands-stage2.ts` sync | Inline, different format from push/pull |
| Doctor check | `  ✓ Fixed  message` or `  ✗  message` | `commands-stage2.ts` doctor | Inline, no helper |
| Section heading | `=== NAME ===` | Proposed for doctor | Not yet a helper |
| Warning | `⚠️  Warning: ...` | `commands-stage2.ts` hooks | Emoji, different from `⚠` used in doctor proposals |
| Error | `Error: message` | `cli.ts` error handler | Uses `formatError()` sometimes, inline other times |
| Completion | `Done: X pushed, Y failed.` | `commands-stage2.ts` | Inline, manual pluralization |
| Count summary | `N file(s)` | Many places | Manual ternary `${n === 1 ? '' : 's'}` repeated everywhere |
| Hook messages | `Installed pre-commit hook.` | `commands-stage2.ts` | Inline, no consistent pattern |

**Solution: expand `format.ts` with semantic helpers.**

All CLI output should go through `format.ts` methods that express *what* is being
displayed, not *how*. The implementor calls a semantic method; formatting details
(indentation, symbols, alignment) are centralized.

**New helpers to add to `format.ts`:**

```typescript
// === Section headings ===
/** Format a section heading: "=== NAME ===" */
formatHeading(name: string): string

// === Diagnostic check results (for doctor) ===
/** Format a passing check: "  ✓  message" */
formatCheckPass(message: string): string
/** Format a failing check: "  ✗  message" */
formatCheckFail(message: string): string
/** Format a warning check: "  ⚠  message" */
formatCheckWarn(message: string): string
/** Format an info check: "  ℹ  message" */
formatCheckInfo(message: string): string
/** Format a fixed issue: "  ✓ Fixed  message" */
formatCheckFixed(message: string): string

// === Transfer results (for push/pull/sync) ===
/** Format a single push result: "  ↑  path (size) - pushed" */
formatPushResult(path: string, size?: number): string
/** Format a single pull result: "  ↓  path (size) - pulled" */
formatPullResult(path: string, size?: number): string
/** Format a transfer failure: "  ✗  path - FAILED: error" */
formatTransferFail(path: string, error: string): string

// === Summaries ===
/** Pluralize: "1 file" / "3 files" */
formatCount(n: number, singular: string, plural?: string): string
/** Format a completion line: "Done: 3 pushed, 1 failed." */
formatCompletionSummary(parts: { label: string; count: number }[]): string

// === Informational messages ===
/** Format a warning message: "⚠  message" */
formatWarning(message: string): string
/** Format a note/hint: "  hint text" */
formatHint(hint: string): string
```

**Symbols centralized in one place.** Currently `FILE_STATE_SYMBOLS` handles file
states. Add a parallel constant for diagnostic/output symbols:

```typescript
export const OUTPUT_SYMBOLS = {
  pass: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
  push: '↑',
  pull: '↓',
  fixed: '✓ Fixed',
} as const;
```

This ensures that every `✓`, `✗`, `⚠`, `↑`, `↓` in the codebase comes from a single
source of truth. No more mixing emoji `⚠️` (hooks warning) with plain `⚠` (doctor).

**Migration strategy:** The new helpers are additive — add them to `format.ts` first,
then systematically replace inline formatting across all commands.
This is done in Phase 0 (below) before any doctor/status work so that all new code uses
the helpers from the start.

### JSON Output (Doctor)

```json
{
  "schema_version": "0.1",
  "status": {
    "files": [
      { "path": "data/model.bin", "state": "synced", "details": "synced", "size": 1258291 }
    ],
    "summary": { "total": 1, "synced": 1 }
  },
  "issues": [
    {
      "type": "hook",
      "severity": "warning",
      "message": "pre-commit hook not installed",
      "fixed": false,
      "fixable": true
    }
  ],
  "summary": {
    "total": 1,
    "errors": 0,
    "warnings": 1,
    "info": 0,
    "fixed": 0,
    "unfixed": 1
  }
}
```

> **Note:** An earlier draft included a `checks` per-category pass/fail section.
> This was removed as redundant with the `issues` array — per-category status can be
> derived from `issues` by grouping on `type`. Keeping the JSON surface smaller reduces
> brittleness.

## Implementation Plan

**Epic:** `blobsy-mtp6` — Spec: Improved doctor and status commands

### Bead Dependency Graph

```
blobsy-wbm2  Phase 0a: Add OUTPUT_SYMBOLS + helpers to format.ts
    │
    ▼
blobsy-1qu8  Phase 0b: Migrate inline formatting to helpers
    │
    ▼
blobsy-nhk1  Phase 1a: DoctorIssue type + shared computeFileStates
    │
    ├──▶ blobsy-qohz  Update status golden tests
    ▼
blobsy-2usw  Phase 1b: File sizes + summary counts in status
    │
    ▼
blobsy-3nbt  Phase 2: Restructure handleDoctor (categories, error boundaries, verbose)
    │
    ├──────────────┬──────────────┬──────────────┐
    ▼              ▼              ▼              ▼
blobsy-q4ae    blobsy-vfay    blobsy-n1hq    blobsy-0dfg
Phase 3:       Phase 4:       Phase 5:       Phase 6:
Config         Hook           Backend        Integrity
validation     checks         tool checks    enhancements
    │              │              │              │
    └──────────────┴──────────────┴──────────────┘
                           │
                           ▼
                   blobsy-uyuo  Add doctor golden tests
                           │
                           ▼
                   blobsy-qoiv  Update design + troubleshooting docs
```

### Phase 0: Output Formatting Consolidation (`blobsy-wbm2`, `blobsy-1qu8`)

Expand `format.ts` with semantic helpers, then migrate all inline formatting across the
CLI to use them.
This phase must land first so all subsequent phases use the helpers from
the start.

- [ ] **`packages/blobsy/src/format.ts`** — Add `OUTPUT_SYMBOLS` constant:
  ```typescript
  export const OUTPUT_SYMBOLS = {
    pass: '\u2713',    // ✓
    fail: '\u2717',    // ✗
    warn: '\u26A0',    // ⚠
    info: '\u2139',    // ℹ
    push: '\u2191',    // ↑
    pull: '\u2193',    // ↓
  } as const;
  ```

- [ ] **`packages/blobsy/src/format.ts`** — Add section heading helper:
  ```typescript
  export function formatHeading(name: string): string {
    return `=== ${name.toUpperCase()} ===`;
  }
  ```

- [ ] **`packages/blobsy/src/format.ts`** — Add diagnostic check result helpers:
  ```typescript
  export function formatCheckPass(message: string): string
  export function formatCheckFail(message: string): string
  export function formatCheckWarn(message: string): string
  export function formatCheckInfo(message: string): string
  export function formatCheckFixed(message: string): string
  ```
  All use `OUTPUT_SYMBOLS` and consistent ` {symbol} {message}` indentation.

- [ ] **`packages/blobsy/src/format.ts`** — Add transfer result helpers:
  ```typescript
  export function formatPushResult(path: string, size?: number): string
  export function formatPullResult(path: string, size?: number): string
  export function formatTransferFail(path: string, error: string): string
  ```
  Replace the inline `↑`/`↓`/`✗` formatting scattered across `commands-stage2.ts`.

- [ ] **`packages/blobsy/src/format.ts`** — Add summary helpers:
  ```typescript
  export function formatCount(n: number, singular: string, plural?: string): string
  export function formatWarning(message: string): string
  export function formatHint(hint: string): string
  ```
  `formatCount(3, 'file')` returns `"3 files"`. Replaces all
  `${n} file${n === 1 ? '' : 's'}` ternaries.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Migrate all inline formatting in
  push/pull/sync handlers to use the new helpers:
  - `handlePush` (~line 170): replace `` ` ${r.path}${sizeStr} - pushed` `` with
    `formatPushResult(r.path, r.bytesTransferred)`.
  - `handlePull` (~line 272): same pattern, use `formatPullResult()`.
  - `handleSync` (~lines 354, 359, 369, 374, 394, 400): replace inline
    `\u2191`/`\u2193`/`\u2717`/`\u2713` with `formatPushResult()`/`formatPullResult()`/
    `formatTransferFail()`/`formatCheckPass()`.
  - `handleDoctor` (~lines 541-543): replace inline `\u2713 Fixed`/`\u2717` with
    `formatCheckFixed()`/`formatCheckFail()`.
  - `handleHooks`: replace emoji `⚠️ Warning:` with `formatWarning()`.
  - Pluralization: replace all `${n === 1 ? '' : 's'}` ternaries with `formatCount()`.

  **Relationship with `formatTransferSummary()`**: The existing
  `formatTransferSummary()` (format.ts:75-103) already uses `↑`/`↓` symbols for batch
  results. The new `formatPushResult`/`formatPullResult` helpers are lower-level building
  blocks. Refactor `formatTransferSummary()` to call them internally, so all transfer
  output flows through the same symbol source.

- [ ] **`packages/blobsy/src/cli.ts`** — Migrate inline formatting:
  - `handleStatus` (line 1066): replace inline
    `` ` ${r.symbol} ${r.path} ${r.details}` `` with `formatFileState()`.
  - `handleStatus` (line 1069): replace inline pluralization
    `` `${results.length} tracked file${results.length === 1 ? '' : 's'}` `` with
    `formatCount()`.
  - `handleVerify` (~line 1119+): same `formatFileState()` pattern.
  - Track command output: replace manual padding with consistent helper.
  - Error handler: ensure all paths use `formatError()`.

- [ ] **`packages/blobsy/src/template.ts`** — Replace bare `console.warn` with
  `formatWarning()`.

- [ ] **Golden tests** — Update expected output in all affected tests to match the
  standardized formatting.
  The output should be visually identical or very close, since the helpers reproduce the
  existing patterns; the main change is consistency.

### Phase 1: Shared Status Infrastructure (`blobsy-nhk1`, `blobsy-2usw`)

Extract status logic so both commands can use it.

- [ ] **`packages/blobsy/src/cli.ts`** — Update `getFileState()` (line 1073) to return
  `size` field. The `.bref` is already read at line 1082 (`readBref(refPath)`); add
  `size: ref.size` to the return type.
  For `missing_ref` state where no bref exists, return `size: undefined`. Update the
  return type:
  ```typescript
  Promise<{ symbol: string; state: string; details: string; size?: number }>
  ```

- [ ] **`packages/blobsy/src/cli.ts`** — Extract status computation from
  `handleStatus()` (lines 1046-1049) into a shared function.
  Place it in `commands-stage2.ts` since that’s where `handleDoctor()` lives:
  ```typescript
  export async function computeFileStates(
    files: { absPath: string; refPath: string; relPath: string }[],
    repoRoot: string,
  ): Promise<{ path: string; symbol: string; state: string; details: string; size?: number }[]>
  ```
  This function calls `getFileState()` for each file and collects results.
  Both `handleStatus()` and `handleDoctor()` call this.

  **Note:** `getFileState()` is currently private in `cli.ts`. Either move it to
  `commands-stage2.ts` alongside `computeFileStates()`, or export it from `cli.ts`.
  Moving is preferable since doctor is in `commands-stage2.ts`.

- [ ] **`packages/blobsy/src/cli.ts`** — Update `handleStatus()` output (lines
  1064-1069):
  - Per-file line: append `(${formatSize(r.size)})` when size is defined.
  - Footer: compute per-state counts from results array and format as
    `${formatCount(total, 'tracked file')}: ${stateParts.join(', ')}`. E.g.,
    `3 tracked files: 1 synced, 1 new, 1 modified`.

- [ ] **`packages/blobsy/src/cli.ts`** — Update JSON output (lines 1051-1063): add
  `size` to each file entry and per-state counts to `summary`:
  ```typescript
  summary: {
    total: results.length,
    ...Object.fromEntries(
      Object.entries(stateCounts).filter(([, v]) => v > 0)
    ),
  }
  ```

- [ ] **`packages/blobsy/src/types.ts`** — Add severity type and update issue interface.
  Add after the existing `StatCacheEntry` interface (~line 52):
  ```typescript
  export type IssueSeverity = 'error' | 'warning' | 'info';

  export interface DoctorIssue {
    type: string;
    severity: IssueSeverity;
    message: string;
    fixed: boolean;
    fixable: boolean;
  }
  ```
  The current inline issue type in `commands-stage2.ts` (line 454) should then reference
  this exported interface.

### Phase 2: Doctor Restructure (`blobsy-3nbt`)

Restructure doctor to run checks in categories with error boundaries.
All output must use Phase 0 helpers (`formatHeading()`, `formatCheckPass()`,
`formatCheckFail()`, etc.)
— no inline symbols.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Restructure `handleDoctor()`
  (currently lines 438-560). The new structure:

  ```typescript
  async function handleDoctor(opts, cmd): Promise<void> {
    // 1. Parse opts, find repo root (existing: lines 439-451)
    // 2. Wrap resolveConfig() in try/catch — if config loading fails,
    //    record as config error but continue with checks that don't need config
    //    (directory, hooks, bref integrity). Set config = null when failed.
    // 3. STATUS section: call computeFileStates(), display directly (no heading)
    // 4. CONFIGURATION section: try/catch, call checkConfig(config, repoRoot, verbose)
    // 5. GIT HOOKS section: try/catch, call checkHooks(repoRoot, fix, verbose)
    // 6. BACKEND section: try/catch, call checkBackend(config, repoRoot, verbose)
    //    — skip if config is null
    // 7. INTEGRITY section: try/catch, call checkIntegrity(allBrefs, repoRoot, fix, verbose)
    // 8. Collect all issues, render summary, set exit code
  }
  ```

  **Critical: `resolveConfig` wrapping.** Currently `resolveConfig()` is called at line
  452 and will throw if `.blobsy.yml` has invalid YAML (because `loadConfigFile()` at
  config.ts:73 throws `ValidationError`). The restructured doctor must catch this early
  and still run non-config-dependent checks.
  Pattern:
  ```typescript
  let config: BlobsyConfig | null = null;
  try {
    config = await resolveConfig(repoRoot, repoRoot);
  } catch (err) {
    issues.push({ type: 'config', severity: 'error', message: ..., fixed: false, fixable: false });
  }
  ```

  **Verbose mode:** Each check category helper takes a `verbose` boolean.
  When verbose, emit `formatCheckPass()` lines for passing checks.
  When not verbose, only emit failing/warning/info checks.
  For sections with zero issues and non-verbose mode, skip the entire section header.

  **Exit code:** Only errors cause exit 1 (warnings are non-fatal):
  `process.exitCode = issues.some(i => !i.fixed && i.severity === 'error') ? 1 : 0`.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Fix `readBref` crash in
  orphan-detection loop (line 477). Currently:
  ```typescript
  const ref = await readBref(refPath);  // throws on invalid YAML!
  ```
  Wrap in try/catch, report as `{ type: 'bref', severity: 'error', message: ... }`.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Move the dynamic import at line
  495:
  ```typescript
  const { readBlobsyBlock } = await import('./gitignore.js');
  ```
  to a top-level import alongside the existing `addGitignoreEntry` import.
  `readBlobsyBlock` is also exported from `gitignore.ts`.

### Phase 3: Configuration Validation Checks (`blobsy-q4ae`)

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add config validation checks in
  doctor. Create a helper `checkConfig()` that runs these checks sequentially:

  1. **Config file exists:** Check `existsSync(getConfigPath(repoRoot))` (existing check
     at line 457, move into the new helper).

  2. **Config file valid YAML:** Already handled by the `resolveConfig()` wrapping in
     Phase 2. If config is null here, skip remaining config checks.

  3. **Global config valid (if present):** Import `getGlobalConfigPath` from `config.ts`
     (line 130). Check `existsSync(globalPath)`, then try `loadConfigFile(globalPath)`
     in a try/catch. Report as warning severity.

  4. **Backend resolves:** Import `resolveBackend` from `transfer.ts` (line 40) — NOT
     from `config.ts`. Call `resolveBackend(config)` which throws `ValidationError` if
     backend name is missing from `backends` section (transfer.ts:50-57). The resolved
     backend also provides the type string for display.

  5. **Backend URL parseable:** If backend has a `url` field, try `parseBackendUrl(url)`
     from `backend-url.ts`. Catch and report as error.

  6. **`externalize.min_size` parseable:** Try `parseSize()` from `config.ts` (line
     346). The `parseSize` regex is at config.ts:351. Catch `ValidationError`.

  7. **`compress.min_size` parseable:** Same pattern.

  8. **`compress.algorithm` valid:** The `CompressConfig` interface (types.ts:92)
     already constrains the type to `'zstd' | 'gzip' | 'brotli' | 'none'`, but raw YAML
     parsing doesn’t enforce this.
     Check at runtime:
     ```typescript
     const validAlgorithms = new Set(['zstd', 'gzip', 'brotli', 'none']);
     if (config.compress?.algorithm && !validAlgorithms.has(config.compress.algorithm)) {
       // warning severity
     }
     ```

  9. **Unknown top-level config keys:** `validateConfigFields()` (config.ts:291) already
     validates known field *types* but does NOT check for unknown keys.
     Add unknown-key detection here (not in `validateConfigFields`, since unknown keys
     are info-level, not errors):
     ```typescript
     const KNOWN_CONFIG_KEYS = new Set([
       'backend', 'backends', 'externalize', 'compress', 'ignore', 'remote', 'sync', 'checksum',
     ]);
     // Source of truth: BlobsyConfig interface in types.ts:100-117
     ```
     For fuzzy “did you mean?”
     matching, use Levenshtein distance <= 2 against known keys.

  10. **Deferred: `remote.key_template` syntax validation.** The known template
      variables for key templates are different from command template variables
      (backend-command.ts:47-52). Key template variables are expanded during push and
      need investigation to enumerate.
      Defer this check to avoid incorrect validation.

### Phase 4: Git Hook Checks (`blobsy-vfay`)

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add hook checks in doctor.
  Create a helper `checkHooks()`. Use the existing `HOOK_TYPES` constant (line 562):
  ```typescript
  const HOOK_TYPES = [
    { name: 'pre-commit', gitEvent: 'pre-commit', bypassCmd: 'git commit --no-verify' },
    { name: 'pre-push', gitEvent: 'pre-push', bypassCmd: 'git push --no-verify' },
  ] as const;
  ```

  For each hook in `HOOK_TYPES`:
  1. Compute path: `join(repoRoot, '.git', 'hooks', hook.name)`.
  2. Check `existsSync(hookPath)`. If missing → warning, fixable.
  3. If exists, `readFileSync(hookPath, 'utf-8')` and check for `'blobsy hook'`
     substring. If not found → warning (non-blobsy hook detected), fixable=false (we
     should NOT overwrite a custom hook without explicit user consent).
  4. If exists and is blobsy-managed, check `fs.accessSync(hookPath, constants.X_OK)`.
     If not executable → warning, fixable (fix: `chmod +x`).

  **With `--fix`:** Reuse the existing hook installation logic from `handleHooks()`
  (line 567). Extract the installation logic into a shared helper that both
  `handleHooks('install', ...)` and the doctor fix path call.
  The existing hook content template is generated in `handleHooks` — extract it so
  doctor can use it.

  **Important:** When a non-blobsy hook is detected, do NOT overwrite with `--fix`. Only
  install when the hook is missing or already blobsy-managed.

### Phase 5: Backend Tool Availability and Command Backend Health Check Fix (`blobsy-n1hq`)

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add backend tool check in doctor.
  This runs after `resolveBackend()` succeeds (Phase 3), so the resolved backend type is
  known:

  - **S3 backends:** Import `isAwsCliAvailable` from `backend-aws-cli.ts` (line 166).
    Call it and report as warning if false (blobsy falls back to built-in S3 SDK). The
    function uses `execFileSync('aws', ['--version'])` internally.

  - **Command backends:** The resolved backend config has `push_command`,
    `pull_command`, `exists_command` fields (types.ts:67-71). For each configured
    command, split on whitespace to get the first token (the binary name), then check it
    exists using `execFileSync('which', [binary])` wrapped in try/catch.
    Report missing binary as error.

  - **Local backends:** No tool check needed (uses filesystem directly).

- [ ] **`packages/blobsy/src/backend-command.ts`** — Fix the no-op `healthCheck()`
  (lines 188-190). Current code:
  ```typescript
  async healthCheck(): Promise<void> {
    // No health check for command backends -- commands are user-defined
  }
  ```

  Replace with:
  ```typescript
  async healthCheck(): Promise<void> {
    // Check that at least one command is configured
    if (!this.config.pushCommand && !this.config.pullCommand) {
      throw new ValidationError('Command backend has no push or pull commands configured.');
    }
    // Verify the command binary exists in PATH
    const command = this.config.pushCommand ?? this.config.pullCommand!;
    const binary = command.split(/\s+/)[0];
    if (!binary) {
      throw new ValidationError('Command template is empty.');
    }
    try {
      execFileSync('which', [binary], { stdio: 'pipe' });
    } catch {
      throw new BlobsyError(
        `Command not found: ${binary}. Ensure it is installed and in your PATH.`,
        'not_found',
      );
    }
  }
  ```
  Note: Use `which` (POSIX) not `where` (Windows).
  If Windows support is needed later, use
  `process.platform === 'win32' ? 'where' : 'which'`.

### Phase 6: Integrity Check Enhancements (`blobsy-0dfg`)

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add `.bref` validation.
  Use `findBrefFiles()` (already called at line 471) to get all bref paths.
  For each:
  - Wrap `readBref()` in try/catch.
    The function (`ref.ts`) throws `UserError` for missing files and `ValidationError`
    for invalid YAML. Report invalid YAML as `{ type: 'bref', severity: 'error', ... }`.
  - For valid brefs, check `ref.format` against `BREF_FORMAT` constant (types.ts:33,
    value: `'blobsy-bref/0.1'`). Report unexpected versions as warning.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add `.blobsy/` gitignore check:
  - Read root `.gitignore` at `join(repoRoot, '.gitignore')`.
  - Check if any line matches `.blobsy` or `.blobsy/`.
  - With `--fix`: use `appendFile()` (NOT `addGitignoreEntry()` which manages the
    per-file blobsy-managed block in subdirectory `.gitignore` files).
    Append `\n.blobsy/\n` to root `.gitignore`, creating it if needed.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add dangling `.gitignore` entry
  check. For each directory containing tracked files:
  - Import `readBlobsyBlock` from `gitignore.ts` (already has this function at
    gitignore.ts:~55). Read the blobsy-managed block entries.
  - For each entry in the block, check if `join(dir, entry + '.bref')` exists.
  - Report dangling entries as
    `{ type: 'gitignore', severity: 'warning', fixable: true }`.
  - With `--fix`: call `removeGitignoreEntry(dir, entry)` from `gitignore.ts`.

  **Collect unique directories:** Build a `Set<string>` of directories from
  `allBrefs.map(p => dirname(join(repoRoot, p)))` to avoid checking the same directory
  multiple times.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add stat cache checks:
  - Import `getStatCacheDir` from `stat-cache.ts` (line 22).
  - The cache stores one JSON file per tracked file, but the filenames are **hashed
    paths** via `getCacheEntryPath()` (from `paths.ts`), not the original filenames.
    Use `glob` or `readdir` recursively to find all `.json` files under
    `.blobsy/stat-cache/`.
  - For each cache file: try `JSON.parse(readFileSync(path))`. If parsing fails →
    `{ type: 'cache', severity: 'warning', fixable: true }`.
  - For valid entries: check `entry.path` field against tracked `.bref` files.
    If no `.bref` exists for `entry.path` →
    `{ type: 'cache', severity: 'info', fixable: true }`.
  - With `--fix`: call `deleteCacheEntry()` from `stat-cache.ts` (line 53) for corrupt
    entries. For stale entries, use `unlink()` directly since we have the cache file
    path.

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add `.blobsy/` writability check:
  - After verifying `.blobsy/` exists, test writability:
    ```typescript
    const testFile = join(blobsyDir, '.doctor-write-test');
    try {
      writeFileSync(testFile, '');
      unlinkSync(testFile);
    } catch {
      issues.push({ type: 'directory', severity: 'error', message: '.blobsy/ is not writable', ... });
    }
    ```

## Design Doc Updates (`blobsy-qoiv`)

### `docs/project/design/current/blobsy-design.md`

- [ ] **Lines 1741-1764 (`blobsy status`)** — Update the example output to show file
  sizes and per-state summary footer.
  Update “What it does” to mention sizes.

- [ ] **Lines 1833-1938 (`blobsy doctor`)** — Update to mark the deferred enhancements
  as implemented:
  - State overview (superset of status)
  - Common error detection (all checks listed above)
  - Troubleshooting advice (context-aware suggestions)
  - Integration validation (hooks, backend tools, config) Remove the “Deferred
    enhancement” label. Update the example output to match the new format with section
    headers and severity markers.

- [ ] **Lines 1898-1923 (deferred enhancements list)** — Replace with “Current behavior”
  that documents the full check list.

### `docs/project/design/current/blobsy-backend-and-transport-design.md`

- [ ] Add a note in the health check section that `CommandBackend.healthCheck()` now
  validates command binary existence (no longer a no-op).

### `docs/troubleshooting.md`

- [ ] Update `blobsy doctor` references to describe the new categorized output.
- [ ] Add guidance: “Run `blobsy doctor --verbose` for full diagnostic detail.”

## Testing Strategy (`blobsy-qohz`, `blobsy-uyuo`)

All tests use the golden session test pattern (tryscript).
Each test file documents the exact CLI behavior as a runnable markdown script.

### Updated Existing Tests

#### `tests/golden/commands/status.tryscript.md` — Add size and summary tests

- [ ] Add test: status output shows file sizes — `(13 B)` suffix after state.
- [ ] Add test: status footer shows per-state counts —
  `2 tracked files: 1 synced, 1 new`.
- [ ] Update all existing expected output to include the new size suffix.

#### `tests/golden/json/status-json.tryscript.md` — Add size and summary fields

- [ ] Update expected JSON: each file entry includes `"size"` field.
- [ ] Update expected JSON: `summary` includes per-state counts (`"synced": 2`, etc.).

#### `tests/golden/commands/doctor.tryscript.md` — Expanded checks

- [ ] Update existing tests to match new categorized output format (section headers).
- [ ] Add test: doctor shows file status section at top (reuses status output).
- [ ] Add test: doctor detects missing git hooks (warning severity).
- [ ] Add test: doctor --fix installs missing hooks.
- [ ] Add test: doctor detects corrupt `.bref` file (error severity, doesn’t crash).
- [ ] Add test: doctor detects `.blobsy/` not in root `.gitignore` (error).

#### `tests/golden/json/doctor-json.tryscript.md` — New JSON shape

- [ ] Update expected JSON to include `status` section, `severity`/`fixable` fields on
  issues, and per-severity counts in `summary`.
- [ ] Add test: JSON output with multiple issue severities.

#### `tests/golden/workflows/doctor-fix.tryscript.md` — Expanded fix tests

- [ ] Add test: doctor --fix installs missing hooks.
- [ ] Add test: doctor --fix removes dangling `.gitignore` entries.
- [ ] Add test: doctor --fix cleans corrupt stat cache entries.
- [ ] Add test: doctor --fix adds `.blobsy/` to root `.gitignore`.

### New Test Files

#### `tests/golden/commands/doctor-config-validation.tryscript.md`

Test configuration validation checks in doctor.

```markdown
---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote
---
# Doctor with no config file

  $ blobsy doctor 2>&1
    No tracked files found.

  === CONFIGURATION ===
    ✗  No .blobsy.yml found
  ...
  ? 1

# Doctor with invalid YAML config

  $ printf "backends:\n  default: [invalid" > .blobsy.yml
  $ blobsy doctor 2>&1
  ...
    ✗  .blobsy.yml: malformed YAML: ...
  ...
  ? 1

# Doctor with invalid min_size

  $ cat > .blobsy.yml << 'YAML'
  backends:
    default:
      url: local:remote
  externalize:
    min_size: "invalid"
  YAML
  $ blobsy doctor 2>&1
  ...
    ⚠  externalize.min_size: invalid size format ...
  ...
  ? 1

# Doctor with invalid compression algorithm

  $ cat > .blobsy.yml << 'YAML'
  backends:
    default:
      url: local:remote
  compress:
    algorithm: lz4
  YAML
  $ blobsy doctor 2>&1
  ...
    ⚠  compress.algorithm: unsupported algorithm "lz4" ...
  ...
  ? 1

# Doctor with unknown config keys (info)

  $ cat > .blobsy.yml << 'YAML'
  backends:
    default:
      url: local:remote
  compres:
    algorithm: zstd
  YAML
  $ blobsy doctor 2>&1
  ...
    ℹ  Unknown config key: "compres" (did you mean "compress"?)
  ...
  ? 0
```

#### `tests/golden/commands/doctor-hooks.tryscript.md`

Test git hook validation in doctor.

```markdown
---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote
---
# Doctor detects missing hooks

  $ blobsy doctor 2>&1
  ...
  === GIT HOOKS ===
    ⚠  pre-commit hook not installed
    ⚠  pre-push hook not installed
  ...

# Doctor --fix installs hooks

  $ blobsy doctor --fix 2>&1
  ...
    ✓ Fixed  Installed pre-commit hook
    ✓ Fixed  Installed pre-push hook
  ...

# Verify hooks installed

  $ test -x .git/hooks/pre-commit && echo "ok"
  ok

# Doctor is clean after fix

  $ blobsy doctor 2>&1
  ...
  === GIT HOOKS ===
    ✓  pre-commit hook installed
    ✓  pre-push hook installed
  ...

# Non-blobsy hook detected

  $ printf '#!/bin/sh\necho custom\n' > .git/hooks/pre-commit
  $ chmod +x .git/hooks/pre-commit
  $ blobsy doctor 2>&1
  ...
    ⚠  pre-commit hook exists but is not managed by blobsy
  ...
```

#### `tests/golden/commands/doctor-integrity.tryscript.md`

Test `.bref` integrity, dangling `.gitignore` entries, and stat cache checks.

```markdown
---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Corrupt .bref file doesn't crash doctor

  $ printf "not valid yaml: [" > data/model.bin.bref
  $ blobsy doctor 2>&1
  ...
    ✗  data/model.bin.bref: malformed .bref file ...
  ...
  ? 1

# Restore valid .bref, add dangling .gitignore entry

  $ git checkout -- data/model.bin.bref
  $ echo "deleted-file.bin" >> data/.gitignore
  $ blobsy doctor 2>&1
  ...
    ⚠  data/deleted-file.bin: .gitignore entry has no corresponding .bref
  ...

# Doctor --fix removes dangling entry

  $ blobsy doctor --fix 2>&1
  ...
    ✓ Fixed  data/deleted-file.bin: removed dangling .gitignore entry
  ...

# .blobsy/ not in root .gitignore (error)

  $ grep -c '.blobsy' .gitignore || echo "not found"
  not found
  $ blobsy doctor 2>&1
  ...
    ✗  .blobsy/ not in root .gitignore
  ...

# Doctor --fix adds .blobsy/ to root .gitignore

  $ blobsy doctor --fix 2>&1
  ...
    ✓ Fixed  Added .blobsy/ to root .gitignore
  ...
  $ grep '.blobsy' .gitignore
  .blobsy/
```

#### `tests/golden/commands/doctor-verbose.tryscript.md`

Test `--verbose` flag shows passing checks.

```markdown
---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
  blobsy hooks install
---
# Doctor --verbose shows all passing checks

  $ blobsy doctor --verbose 2>&1
      ✓  data/model.bin   synced ...
  ...
  === CONFIGURATION ===
    ✓  .blobsy.yml valid
    ✓  Backend: local:remote (local)
  ...
  === GIT HOOKS ===
    ✓  pre-commit hook installed
    ✓  pre-push hook installed
  ...
  === BACKEND ===
    ✓  Backend reachable and writable
  ...
  === INTEGRITY ===
    ✓  1 .bref file valid
  ...
  No issues found.
  ? 0
```

#### `tests/golden/json/doctor-json-v2.tryscript.md`

Test the new JSON output shape with severity, checks sections.

```markdown
---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Doctor --json: healthy repo with new shape

  $ blobsy doctor --json
  {
    "schema_version": "0.1",
    "status": {
      "files": [
        {
          "path": "data/model.bin",
          "state": "synced",
          "details": "synced",
          "size": 13
        }
      ],
      "summary": {
        "total": 1,
        "synced": 1
      }
    },
    "issues": [],
    "summary": {
      "total": 0,
      "errors": 0,
      "warnings": 0,
      "info": 0,
      "fixed": 0,
      "unfixed": 0
    }
  }
  ? 0

# Doctor --json with issues (severity included)

  $ echo "" > data/.gitignore
  $ rm -f .git/hooks/pre-commit .git/hooks/pre-push
  $ blobsy doctor --json
  {
    "schema_version": "0.1",
    "status": { ... },
    "issues": [
      {
        "type": "hook",
        "severity": "warning",
        "message": "pre-commit hook not installed",
        "fixed": false,
        "fixable": true
      },
      {
        "type": "hook",
        "severity": "warning",
        "message": "pre-push hook not installed",
        "fixed": false,
        "fixable": true
      },
      {
        "type": "gitignore",
        "severity": "error",
        "message": "data/model.bin: missing from .gitignore",
        "fixed": false,
        "fixable": true
      }
    ],
    "summary": {
      "total": 3,
      "errors": 1,
      "warnings": 2,
      "info": 0,
      "fixed": 0,
      "unfixed": 3
    }
  }
  ? 1
```

### Backward Compatibility

The JSON output changes are additive:
- `status` JSON: adds `size` field to file entries, adds per-state counts to `summary`.
  Existing fields unchanged.
- `doctor` JSON: adds `status` section, `severity`/`fixable` to issues, restructured
  `summary` with per-severity counts.
  The `issues` array format changes (adds fields), but existing fields (`type`,
  `message`, `fixed`) are preserved.

The human-readable output changes format:
- `status`: adds file size suffix, changes footer from `N tracked files` to
  `N tracked files: X synced, Y new, ...`.
- `doctor`: adds section headers, reorganizes output.
  This is a visual-only change with no scripting impact (scripts should use `--json`).

## Open Questions

1. **Should `blobsy doctor` check for large untracked files?** Files exceeding
   `externalize.min_size` that aren’t tracked could be flagged as info-level issues.
   Potentially noisy in repos with many large files that are intentionally not tracked.
   Decision: defer to a future version, add if users request it.

2. **Should `blobsy stats` still exist as a separate command?** The design doc defines
   it but it’s marked as deferred.
   With doctor including status output, a separate `stats` command may be redundant.
   Decision: defer `stats` — doctor provides the aggregate view.

3. **Exit code semantics.** Only `severity === 'error'` causes exit code 1. Warnings are
   non-fatal (exit 0) since they indicate suboptimal but functional state.
   This matches user expectations: missing hooks are annoying but don’t prevent
   operation.

## Review Notes (2026-02-23)

Issues found during senior engineering review.
Items marked **[FIXED]** have been addressed in this revision.
Items marked **[NOTED]** are documented for implementors.

1. **[FIXED] `checks` section in JSON design was undocumented.** The JSON design showed
   a per-category `checks` section that was never referenced in implementation phases or
   tests. Removed as redundant with `issues` array.

2. **[FIXED] `--verbose` contradiction.** The healthy-repo example (lines 159-187)
   showed passing checks without `--verbose`, but the text said passing checks are
   hidden without `--verbose`. Resolved: the example is `--verbose` output; non-verbose
   healthy repos show only status section and “No issues found.”

3. **[FIXED] Stale line number references.** The spec referenced `cli.ts` line 935 for
   `handleStatus` but the actual location is line 1019. All line references updated to
   current values. Line numbers in implementation tasks use `~lineN` to indicate
   approximate locations that should be verified at implementation time.

4. **[FIXED] `resolveBackend` location.** The function is in `transfer.ts:40`, not
   `config.ts`. Phase 3 now correctly references the import source.

5. **[FIXED] `resolveConfig` crash path.** Doctor calls `resolveConfig()` which calls
   `loadConfigFile()` which throws on invalid YAML. Phase 2 now wraps this in try/catch
   with fallback behavior documented.

6. **[FIXED] `formatTransferSummary` relationship.** Phase 0 adds new
   `formatPushResult`/`formatPullResult` helpers but didn’t address the existing
   `formatTransferSummary()`. Now documented: refactor `formatTransferSummary` to use
   the new helpers internally.

7. **[FIXED] `.blobsy/` gitignore fix uses wrong function.** Phase 6 now explicitly
   notes to use `appendFile()`, NOT `addGitignoreEntry()` (which manages per-file
   blocks).

8. **[NOTED] `validateConfigFields` exists.** `config.ts:291-313` already validates
   field types for `backends`, `externalize`, `compress`, and `ignore`. The unknown-key
   check in Phase 3 is additive and should NOT be added to `validateConfigFields` (since
   unknown keys are info-level, not errors).

9. **[NOTED] Stat cache file naming.** Cache entries use hashed paths via
   `getCacheEntryPath()` from `paths.ts`. The implementor must recursively scan the
   directory, not match filenames to tracked file names.

10. **[NOTED] `remote.key_template` validation deferred.** The known template variables
    for key templates need investigation to enumerate.
    Deferred from Phase 3.

11. **[NOTED] Phase 0 blast radius.** Migrating ALL inline formatting across every
    command is a large change that will break many golden tests.
    Consider splitting Phase 0 into:
    - **Phase 0a:** Add helpers + `OUTPUT_SYMBOLS` to `format.ts` (no existing code
      changes)
    - **Phase 0b:** Migrate existing commands to use helpers (updates golden tests)

    This allows Phase 0a to land as a safe, non-breaking commit.

12. **[NOTED] Non-blobsy hooks.** Phase 4 clarifies that `--fix` should NOT overwrite
    non-blobsy hooks. The spec’s hook check table said fixable=yes for “Hook content
    contains `blobsy hook`” but the implementation detail now says fixable=false for
    non-blobsy hooks to avoid destroying user customizations.

## References

- Design doc doctor section: `docs/project/design/current/blobsy-design.md` lines
  1833-1938
- Design doc status section: `docs/project/design/current/blobsy-design.md` lines
  1741-1764
- Backend design doc:
  `docs/project/design/current/blobsy-backend-and-transport-design.md`
- Testing design doc: `docs/project/design/current/blobsy-testing-design.md`
- Prior review findings: conversation context (2026-02-23 engineering review)
