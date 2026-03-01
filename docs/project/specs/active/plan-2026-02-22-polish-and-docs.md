# Feature: Polish and Docs

**Date:** 2026-02-22

**Author:** Joshua Levy with LLM assistance

**Status:** Implemented (2026-02-24)

## Overview

Various polish items before initial release:

1. **P0 Bug: Directory walk ignores `.gitignore` and `config.ignore` patterns.**
   `blobsy track .` walks into `node_modules/`, `dist/`, and other gitignored
   directories. The `walkDir()` function in `paths.ts` only skips dotfiles/dotdirs (names
   starting with `.`). The `config.ignore` field has sensible defaults
   (`node_modules/**`, `.git/**`, `.blobsy/**`, `*.tmp`) but is never applied during
   directory walking. The existing `filterFilesForExternalization()` in `externalize.ts`
   accepts ignore patterns but is never called from the track workflow.
   **Bead:** `blobsy-0eql`

2. **Empty default `always` list:** Remove the hardcoded default `always` patterns
   (`*.parquet`, `*.bin`, etc.)
   so that directory tracking relies purely on `min_size` by default.
   Users can still configure `always` patterns in `.blobsy.yml`.

3. **`--min-size` flag on `track`:** Add a CLI flag to override the configured
   `min_size` threshold for a single invocation, e.g.
   `blobsy track --min-size 100kb data/`.

4. **New `blobsy add` command:** High-level command that runs `blobsy track` internally,
   then `git add`s all resulting changes: `.bref` files, `.gitignore` modifications, and
   non-externalized files found during directory walks (small files that belong in git).
   `blobsy track` remains unchanged as the low-level command (no git staging).
   **Bead:** `blobsy-4vlz`

5. **`blobsy readme` and `blobsy docs` commands:** Add CLI commands for human-facing
   documentation. `readme` outputs the project README; `docs` outputs a comprehensive
   user guide covering configuration, externalization rules, compression, backends, and
   workflows (referencing `--help` for command details rather than duplicating them).

6. **Colored help output and CLI polish:** Add `picocolors` for styled `--help` output
   (bold cyan headers, green commands, yellow options).
   Replace the custom `formatHelp` function with Commander v14’s built-in styled help.
   Add `showHelpAfterError()` for better error messages and a colored epilog.

7. **Implement git hooks (pre-commit validation + pre-push auto-push):** The pre-commit
   hook currently exists as a no-op stub.
   Implement two hooks: (a) pre-commit verifies that staged `.bref` files have valid
   hashes (fast, local sanity check), (b) pre-push auto-runs `blobsy push` to upload
   blobs before git refs are pushed (ensures blobs and refs arrive together).
   Both hooks are installed by default via `blobsy init` but can be skipped with
   `blobsy init --no-hooks` or disabled with `BLOBSY_NO_HOOKS=1`. The `blobsy hooks`
   command is expanded to manage both hooks.

8. **Enhance `blobsy config` with `--global`, `--show-origin`, and `--unset`:** The
   existing `config` command only reads/writes the repo-root `.blobsy.yml`. Add
   `--global` to write to `~/.blobsy.yml`, `--show-origin` to display where a value
   comes from (git-style: scope + file path), and `--unset` to remove a key.
   Follows `git config` conventions so the mental model is familiar.

## Goals

- Fix critical bug: directory walk must respect `.gitignore` and `config.ignore`
  patterns
- Make default behavior simpler and more predictable: “files >= 1MB get externalized”
- Remove implicit magic (auto-externalizing `.parquet` files of any size is surprising)
- Give users a quick CLI escape hatch to adjust the threshold without editing config
- Reduce the add-commit workflow from 3 steps to 2 (`blobsy add .` + `git commit`)
- Provide human-readable documentation directly from the CLI (`blobsy readme`,
  `blobsy docs`) without requiring a browser or external files
- Polish the CLI help output with colored text (commands, options, headers) for
  readability and professional feel, matching tbd’s level of polish
- Implement the two git hooks the design doc specifies: pre-commit hash validation and
  pre-push blob upload.
  Ensure hooks are opt-out (installed by default, skippable)
- Make `blobsy config` a proper multi-level config tool (analogous to `git config`) with
  `--global`, `--show-origin`, and `--unset`

## Non-Goals

- Changing the externalization rule precedence (never > always > min_size)
- Adding CLI flags for `--always` or `--never` patterns (config-only is fine)
- Changing the default `min_size` value (stays at `200kb`)
- Full `.gitignore` parsing (use `config.ignore` patterns with picomatch; defer actual
  `.gitignore` file reading to a future version if needed)
- A `blobsy unstage` command (use `git restore --staged` directly; revisit if users
  request it)

## Implementation Plan

### Phase 0: P0 Bug Fix — Directory Walk Must Respect Ignore Patterns

**Problem:** `walkDir()` in `paths.ts:126-141` only skips entries starting with `.`. The
`config.ignore` field (default: `['node_modules/**', '.git/**', '.blobsy/**', '*.tmp']`)
is loaded but never used.
`filterFilesForExternalization()` in `externalize.ts:41-60` accepts ignore patterns but
is never called from the track workflow.

**Approach:** Apply `config.ignore` patterns during the directory walk itself (not
post-filter), so we never recurse into ignored directories like `node_modules/`. This is
both correct (no wasted I/O) and safe (no risk of accidentally processing thousands of
files).

**Reference code from tbd** (copy and adapt as needed):

- `attic/tbd/packages/tbd/src/utils/gitignore-utils.ts` — `hasGitignorePattern()` for
  pattern matching with trailing-slash normalization, `ensureGitignorePatterns()` for
  idempotent `.gitignore` management with atomic writes.
  Comprehensive tests at `attic/tbd/packages/tbd/tests/gitignore-utils.test.ts`.
- `attic/tbd/packages/tbd/src/file/git.ts` — `git()` wrapper using `execFile` (safe
  against shell injection, 50MB buffer).
  Also has `withIsolatedIndex()` for git operations that don’t disturb the user’s
  staging area (may be useful for `blobsy add` if we want to stage without side effects
  on partial failures).

#### Code Changes

- [ ] **`packages/blobsy/src/paths.ts:115-141`** — Modify `findTrackableFiles()` and
  `walkDir()` to accept ignore patterns and skip matching directories and files:

  ```typescript
  export function findTrackableFiles(dir: string, ignorePatterns?: string[]): string[] {
    const matcher = ignorePatterns?.length
      ? picomatch(ignorePatterns, { dot: true })
      : null;
    const results: string[] = [];
    walkDir(dir, dir, matcher, (filePath) => {
      const name = basename(filePath);
      if (!name.endsWith(BREF_EXTENSION) && !name.startsWith('.')) {
        results.push(filePath);
      }
    });
    return results.sort();
  }

  function walkDir(
    dir: string,
    rootDir: string,
    ignoreMatcher: ((path: string) => boolean) | null,
    callback: (filePath: string) => void,
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      const relPath = normalizePath(relative(rootDir, fullPath));
      // Check ignore patterns against relative path and name
      if (ignoreMatcher && (ignoreMatcher(relPath) || ignoreMatcher(entry.name))) {
        continue;
      }
      if (entry.isDirectory()) {
        // Also check directory with trailing slash for glob patterns like "node_modules/"
        const dirRel = relPath + '/';
        if (ignoreMatcher && ignoreMatcher(dirRel)) continue;
        walkDir(fullPath, rootDir, ignoreMatcher, callback);
      } else if (entry.isFile()) {
        callback(fullPath);
      }
    }
  }
  ```

  Note: `picomatch` is already a dependency.
  Add import at top of `paths.ts`.

- [ ] **`packages/blobsy/src/cli.ts`** (`trackDirectory`, ~line 619) — Pass
  `config.ignore` to `findTrackableFiles()`:

  ```typescript
  const files = findTrackableFiles(absDir, config.ignore);
  ```

- [ ] **`packages/blobsy/src/cli.ts`** — Also update `findBrefFiles()` calls if they
  walk directories (check if `findBrefFiles` in `paths.ts:101-109` also needs ignore
  patterns — it’s used by `status`, `verify`, `push`, `pull`, `sync` and should also
  skip ignored directories)

- [ ] **`packages/blobsy/src/config.ts:70`** — Review default ignore patterns.
  Current: `['node_modules/**', '.git/**', '.blobsy/**', '*.tmp']`. Consider adding
  common patterns like `dist/**`, `build/**`, `__pycache__/**`, `.DS_Store`

  Design doc (line 2148-2154) specifies:
  ```yaml
  ignore:
    - "__pycache__/"
    - "*.pyc"
    - ".DS_Store"
    - "node_modules/"
    - ".git/"
    - ".blobsy.yml"
  ```

  Align the code defaults with the design doc.

#### Test Changes

- [ ] **`packages/blobsy/tests/paths.test.ts`** — Add unit tests:
  - `findTrackableFiles()` with ignore patterns skips `node_modules/` directory entirely
  - `findTrackableFiles()` with ignore patterns skips files matching `*.tmp`
  - `findTrackableFiles()` with no patterns behaves as before (only skips dotfiles)
  - Verify that `walkDir` doesn’t recurse into ignored directories (check that deeply
    nested files inside `node_modules/` are not visited)

- [ ] **`packages/blobsy/tests/golden/commands/track.tryscript.md`** — Add golden test:
  create a directory with `node_modules/` subdir containing a large file, run
  `blobsy track .`, verify `node_modules/` files are not tracked

- [ ] **`packages/blobsy/tests/golden/commands/externalization.tryscript.md`** — Add
  golden test: custom `ignore` patterns in config skip matching files during directory
  tracking

- [ ] **`packages/blobsy/tests/externalize.test.ts`** — Existing
  `filterFilesForExternalization()` tests already cover ignore filtering; verify they
  still pass

- [ ] **`packages/blobsy/tests/golden/commands/status.tryscript.md`** — If
  `findBrefFiles()` is updated to accept ignore patterns (item 3 above), add a golden
  test: `blobsy status` in a repo with `.bref` files inside `node_modules/` verifies
  they are not listed

#### Documentation Changes

- [ ] **`README.md`** — Add an “Ignore Patterns” section (or a note under
  Externalization Rules) explaining that `blobsy track .` skips `node_modules/`,
  `.git/`, `.blobsy/`, and `*.tmp` by default, configurable via `ignore` in
  `.blobsy.yml`

- [ ] **`packages/blobsy/SKILL.md`** — Mention that directory tracking skips ignored
  patterns

- [ ] **`CHANGELOG.md`** — Add “Fixed” entry: directory tracking now respects
  `config.ignore` patterns (previously walked into `node_modules/` etc.)

- [ ] **`docs/project/design/current/blobsy-design.md`** — No changes needed (design doc
  already specifies this behavior at lines 1339 and 2226-2228; the implementation was
  simply missing)

### Phase 1: Empty Default `always` List

#### Code Changes

- [ ] **`packages/blobsy/src/config.ts:28-38`** — Change the `always` array in
  `getBuiltinDefaults()` from `['*.parquet', '*.bin', '*.weights', ...]` to `[]`

#### Test Changes

- [ ] **`packages/blobsy/tests/config.test.ts`** — Update any assertions that check the
  default `always` list contents
- [ ] **`packages/blobsy/tests/externalize.test.ts`** — Verify tests use explicit
  configs (not built-in defaults); update if any rely on the default patterns
- [ ] **`packages/blobsy/tests/golden/commands/externalization.tryscript.md`** — Update
  golden output if it shows default patterns
- [ ] **`packages/blobsy/tests/golden/commands/track.tryscript.md`** — Update golden
  output if externalization decisions change for test files

#### Documentation Changes

- [ ] **`README.md`** — Update the Externalization Rules example to show `always` as a
  user-configured option (not as if it ships with defaults).
  Note the default is `min_size: 200kb` only
- [ ] **`packages/blobsy/SKILL.md`** — Update externalization description if it
  references default patterns
- [ ] **`CHANGELOG.md`** — Add “Changed” entry: default `always` list is now empty
- [ ] **`docs/project/design/current/blobsy-design.md`** — Review externalization rule
  examples; ensure they show `always` as user-configured, not as defaults

### Phase 2: `--min-size` Flag on `track`

#### Code Changes

- [ ] **`packages/blobsy/src/cli.ts:170-175`** — Add
  `.option('--min-size <size>', 'Override minimum file size for directory tracking (e.g. "100kb", "5mb")')`
  to the `track` command registration
- [ ] **`packages/blobsy/src/cli.ts:503-522`** (`handleTrack`) — Read the `--min-size`
  option from `opts`, pass it through to `trackDirectory()`
- [ ] **`packages/blobsy/src/cli.ts:619-721`** (`trackDirectory`) — If `--min-size` is
  provided, create a modified `ExternalizeConfig` with the override before calling
  `shouldExternalize()`. The override replaces `config.externalize.min_size` for this
  invocation only
- [ ] **`packages/blobsy/src/externalize.ts`** — No changes needed (already accepts
  `min_size` via config)

#### Test Changes

- [ ] **`packages/blobsy/tests/externalize.test.ts`** — Add unit test: config with
  `min_size` override produces correct externalization decisions
- [ ] **`packages/blobsy/tests/golden/commands/track.tryscript.md`** — Add golden test:
  `blobsy track --min-size 50 <dir>` externalizes small files
- [ ] **`packages/blobsy/tests/golden/commands/externalization.tryscript.md`** — Add
  golden test: `--min-size` overrides config file setting
- [ ] **`packages/blobsy/tests/golden/json/track-json.tryscript.md`** — Add golden test:
  `blobsy track --json --min-size <size> <dir>` output shape

#### Documentation Changes

- [ ] **`README.md`** — Add `--min-size` to the Quick Start or Externalization Rules
  section
- [ ] **`packages/blobsy/SKILL.md`** — Add `--min-size` to track command reference
- [ ] **`CHANGELOG.md`** — Add “Added” entry: `--min-size` flag on `track` command

## Behavior Specification

### `--min-size` Flag

- Accepts human-readable size strings: `100kb`, `1mb`, `5mb`, `1gb`, or raw bytes
- Only affects directory tracking (ignored when tracking a specific file, since explicit
  files always externalize)
- Overrides `externalize.min_size` from `.blobsy.yml` for this invocation only
- Does NOT affect `always` or `never` patterns (those still apply)
- If both `--min-size` and config are present, CLI flag wins

### Examples

```bash
# Track everything >= 100KB in data/ (overrides default 1MB)
blobsy track --min-size 100kb data/

# Track everything >= 10MB in current directory (more conservative)
blobsy track --min-size 10mb .

# Works with blobsy add too (track + stage)
blobsy add --min-size 100kb data/

# Explicit file always externalizes (--min-size ignored)
blobsy track --min-size 10mb tiny-but-important.bin
```

### Phase 3: New `blobsy add` Command

**Design:** Two commands with clear separation of concerns:

- **`blobsy track`** — Low-level.
  Creates `.bref` files, updates `.gitignore`. Does NOT touch git staging.
  Unchanged from current behavior.
- **`blobsy add`** — High-level “do the right thing” command.
  Runs `track` internally, then stages everything to git.
  The recommended command for the common workflow.

This is cleaner than a `--no-stage` flag because each command does exactly one thing.
`track` stays backwards-compatible with zero changes.
`add` is the new recommended entry point.

#### Behavior Specification

Both `track` and `add` accept one or more paths.
Each path can be a file or a directory:

```bash
blobsy add .                          # current directory (recursive)
blobsy add data/                      # specific subdirectory (recursive)
blobsy add data/model.bin             # specific file
blobsy add data/ experiments/ big.bin # mix of directories and files
```

**Directory path (`blobsy add <dir>`):**

1. Runs `blobsy track <dir>` internally (walk directory, externalize large files, create
   `.bref`, update `.gitignore`)
2. Then runs `git add` on:
   - All `.bref` files created or modified during this invocation
   - All `.gitignore` files modified during this invocation
   - All non-externalized files found during the directory walk (files that passed the
     ignore filter but were below `min_size` and not in `always` patterns — small files
     that belong directly in git)
3. Prints a staging summary and hint message

**Explicit file path (`blobsy add <file>`):**

1. Runs `blobsy track <file>` internally (always externalizes, regardless of size)
2. Then runs `git add` on:
   - The `.bref` file created or modified
   - The `.gitignore` file modified

**What does NOT get staged:**

- Files matching `config.ignore` patterns (already skipped during walk)
- Files already in user’s `.gitignore` (`git add` silently skips these)
- Nothing is staged in `--dry-run` mode

**`blobsy add` accepts all the same flags as `track`:** `--force`, `--min-size`,
`--dry-run`, `--json`, `--quiet`, `--verbose`.

**Workflow:**

```bash
# Recommended (2 steps):
blobsy add .            # externalize + stage everything in current dir
git commit -m "Track files"

# Specific directory:
blobsy add data/        # just the data/ subtree
git commit -m "Track data files"

# Power-user (3 steps, fine-grained control):
blobsy track .          # just create .bref files, no staging
git add -A              # manual staging
git commit -m "Track files"
```

**Example output:**

```bash
$ blobsy add .
Scanning ./...
  data/model.bin         (500 MB)  -> tracked (.bref)
  data/config.json       (  2 KB)  -> kept in git
  data/notes.txt         (500  B)  -> kept in git
1 file externalized, 2 kept in git.
Staged 4 files (1 .bref, 1 .gitignore, 2 kept in git).
Changes have been staged to git: run `git status` to review and `git commit` to commit.

$ blobsy add data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore
Staged 2 files (1 .bref, 1 .gitignore).
Changes have been staged to git: run `git status` to review and `git commit` to commit.
```

#### Code Changes

- [ ] **`packages/blobsy/src/cli.ts`** — Register the `add` command (before `track` in
  the command list, since it’s the recommended entry point):

  ```typescript
  program
    .command('add')
    .description('Track files and stage changes to git (recommended)')
    .argument('<path...>', 'Files or directories to add')
    .option('--force', 'Skip confirmation for destructive operations')
    .option('--min-size <size>', 'Override minimum file size for directory tracking')
    .action(wrapAction(handleAdd));
  ```

- [ ] **`packages/blobsy/src/cli.ts`** — Refactor `trackSingleFile()` and
  `trackDirectory()` to return a `TrackResult` instead of `void`:

  ```typescript
  interface TrackResult {
    /** Absolute paths of files to git-add */
    filesToStage: string[];
    /** Count of files externalized (got .bref) */
    externalized: number;
    /** Count of files unchanged (already tracked, same hash) */
    unchanged: number;
    /** Count of non-externalized files found during directory walk */
    keptInGit: number;
  }
  ```

  **Important implementation details:**

  - `addGitignoreEntry()` in `gitignore.ts:21` returns `Promise<void>` — it does NOT
    return the path of the modified `.gitignore`. Callers must manually derive the
    `.gitignore` path: `join(dirname(absPath), '.gitignore')`.
  - `execFileSync` is not currently imported in `cli.ts` — add
    `import { execFileSync } from 'node:child_process'` for Phase 3’s `handleAdd()`.
  - Stat cache entries (`writeCacheEntry()`) are internal and must NOT go in
    `filesToStage`.

  **`trackSingleFile()` changes:** After the existing `writeBref()` and
  `addGitignoreEntry()` calls (~lines 599-602), compute and collect the paths:

  ```typescript
  const refPath = brefPath(absPath); // already computed above
  const gitignorePath = join(dirname(absPath), '.gitignore');
  result.filesToStage.push(refPath, gitignorePath);
  result.externalized++;
  ```

  For the “unchanged” early return (~line 565), set `result.unchanged++` and return the
  result with an empty `filesToStage` (nothing changed, nothing to stage).

  **`trackDirectory()` changes:** In the per-file loop, collect paths for BOTH
  externalized and non-externalized files:

  ```typescript
  // Non-externalized files (below min_size, not in always): keep in git
  if (!shouldExternalize(relFilePath, fileSize, extConfig)) {
    result.keptInGit++;
    result.filesToStage.push(absFilePath);
    continue;
  }

  // Externalized files: after writeBref() and addGitignoreEntry() calls,
  // collect .bref and .gitignore paths
  const refPath = brefPath(absFilePath);
  const gitignorePath = join(dirname(absFilePath), '.gitignore');
  result.filesToStage.push(refPath, gitignorePath);
  result.externalized++;
  ```

  **Deduplication:** Multiple files in the same directory produce the same `.gitignore`
  path. Deduplicate `filesToStage` before returning (or in `handleAdd()` before calling
  `git add`):

  ```typescript
  result.filesToStage = [...new Set(result.filesToStage)];
  ```

- [ ] **`packages/blobsy/src/cli.ts`** — `handleTrack()` remains unchanged (calls
  `trackSingleFile` / `trackDirectory`, ignores the returned `filesToStage`). This keeps
  `blobsy track` behavior identical to today.

- [ ] **`packages/blobsy/src/cli.ts`** — New `handleAdd()` function.
  Reference `attic/tbd/packages/tbd/src/file/git.ts` for safe git command execution
  patterns (`execFile` with array args, not shell strings):

  ```typescript
  async function handleAdd(
    paths: string[],
    opts: Record<string, unknown>,
    cmd: Command,
  ): Promise<void> {
    const globalOpts = getGlobalOpts(cmd);
    const repoRoot = findRepoRoot();
    const cacheDir = getStatCacheDir(repoRoot);
    const config = await resolveConfig(repoRoot, repoRoot);

    const allFilesToStage: string[] = [];

    for (const inputPath of paths) {
      const absPath = resolveFilePath(stripBrefExtension(inputPath));
      let result: TrackResult;
      if (isDirectory(absPath)) {
        result = await trackDirectory(absPath, repoRoot, cacheDir, config, globalOpts);
      } else {
        result = await trackSingleFile(absPath, repoRoot, cacheDir, globalOpts);
      }
      allFilesToStage.push(...result.filesToStage);
    }

    // Stage to git
    if (!globalOpts.dryRun && allFilesToStage.length > 0) {
      execFileSync('git', ['add', '--', ...allFilesToStage], {
        cwd: repoRoot,
        stdio: 'pipe',
      });

      if (!globalOpts.quiet && !globalOpts.json) {
        const brefCount = allFilesToStage.filter(f => f.endsWith('.bref')).length;
        const gitignoreCount = allFilesToStage.filter(f =>
          basename(f) === '.gitignore').length;
        const keptCount = allFilesToStage.length - brefCount - gitignoreCount;
        const parts = [];
        if (brefCount > 0) parts.push(`${brefCount} .bref`);
        if (gitignoreCount > 0) parts.push(`${gitignoreCount} .gitignore`);
        if (keptCount > 0) parts.push(`${keptCount} kept in git`);
        console.log(`Staged ${allFilesToStage.length} files (${parts.join(', ')}).`);
        console.log(
          "Changes have been staged to git: run `git status` to review and `git commit` to commit."
        );
      }
    }
  }
  ```

  Use `execFileSync` (not `execSync`) to avoid shell injection.
  Pass paths as array arguments.

  Note: If the file list is very large (thousands of files), `git add` may hit
  `ARG_MAX`. For the initial release this is acceptable — typical usage involves tens to
  hundreds of files. If needed later, batch into multiple `git add` calls.

#### Test Changes

- [ ] **`packages/blobsy/tests/golden/commands/add.tryscript.md`** — New golden test
  file for `blobsy add`. Comprehensive scenarios:
  - `blobsy add .` with mixed file sizes: verify staging summary and hint message
  - `blobsy add data/model.bin` for explicit file: verify `.bref` and `.gitignore`
    staged
  - After `blobsy add .`, run `git status --porcelain` to verify files are staged (not
    just modified in working tree)
  - `blobsy add data/ experiments/` with multiple directory arguments
  - `blobsy add data/ big.bin` with mix of directories and explicit files
  - Idempotent: `blobsy add .` twice produces “already tracked (unchanged)” on second
    run and stages no additional files
  - After `blobsy add .`, verify non-externalized small files are staged directly to git
    (not just `.bref` and `.gitignore` files)
  - `blobsy add --min-size 50 data/`: verify `--min-size` flag works with `add` (uses
    lower threshold, externalizes smaller files, stages results)
  - `blobsy add --force data/model.bin`: verify `--force` flag is accepted

- [ ] **`packages/blobsy/tests/golden/commands/dry-run.tryscript.md`** — Add dry-run
  tests for `add`:
  - `blobsy --dry-run add data/model.bin`: shows “Would track” but no files staged
  - `blobsy --dry-run add .`: shows what would happen, verify `git status` shows nothing
    staged afterward

- [ ] **`packages/blobsy/tests/golden/commands/quiet.tryscript.md`** — Add quiet test
  for `add`:
  - `blobsy --quiet add .`: no output, but files are staged (verify with `git status`)

- [ ] **`packages/blobsy/tests/golden/commands/verbose.tryscript.md`** — Add verbose
  test for `add`:
  - `blobsy --verbose add .`: shows detailed per-file output plus staging summary

- [ ] **`packages/blobsy/tests/golden/commands/track.tryscript.md`** — Verify `track`
  behavior is unchanged (no staging): after `blobsy track .`, run `git status` and
  confirm nothing is staged

- [ ] **`packages/blobsy/tests/golden/json/add-json.tryscript.md`** — New golden test:
  - `blobsy add --json data/model.bin`: verify JSON envelope with `schema_version`
  - `blobsy add --json .`: verify JSON output includes tracked/staged file counts
  - `blobsy --dry-run --json add .`: verify JSON dry-run output shape

- [ ] **`packages/blobsy/tests/golden/commands/help.tryscript.md`** — Update:
  - `add` appears in top-level help command list
  - Add per-command help section: `blobsy add --help` shows arguments, `--force`,
    `--min-size` options

#### Documentation Changes

- [ ] **`README.md`** — Update Quick Start to use `blobsy add .` as the primary command.
  Keep `blobsy track` in the Commands table as the low-level alternative.
  Add `add` to the Commands table with description “Track files and stage to git
  (recommended)”

- [ ] **`packages/blobsy/SKILL.md`** — Add `blobsy add` to command reference; mark it as
  the recommended command for the common workflow

- [ ] **`CHANGELOG.md`** — Add “Added” entry: `blobsy add` command (track + git stage)

- [ ] **`docs/project/design/current/blobsy-design.md`** — Add `blobsy add` to the CLI
  Commands section. Update workflow examples to show `blobsy add` as the primary path.
  Keep `blobsy track` documented as the low-level command

### Phase 4: `blobsy readme` and `blobsy docs` Commands

Add two new CLI commands for human-facing documentation.
Follow tbd’s patterns (`attic/tbd/packages/tbd/src/cli/commands/docs.ts`, `readme.ts`):

- **File-based docs bundled at build time** — actual `.md` files in
  `packages/blobsy/docs/` copied to `dist/docs/` during postbuild (not embedded string
  constants)
- **Markdown terminal rendering** — `marked` + `marked-terminal` for colorized output
  when stdout is a TTY; plain markdown when piped (agent/script compatible)
- **Pagination** — long output piped through `less -R` (or `$PAGER`) when interactive
- **Section navigation for `docs`** — `blobsy docs <topic>` shows a specific `##`
  section; `--list` enumerates available sections

#### 4a. New Dependencies

- [ ] **`packages/blobsy/package.json`** — Add to `dependencies`:

```json
"marked": "^15.0.0",
"marked-terminal": "^7.3.0"
```

Note: `marked-terminal` types are outdated (see tbd’s `output.ts:207` cast workaround).
No `@types/*` needed; `marked` ships its own types.

**Implementation notes:**

- All utility functions (`isInteractive`, `renderMarkdown`, `paginateOutput`,
  `extractSections`, `findSection`, `DocSection`) go in `markdown-output.ts`.
  `loadBundledDoc()` goes in `cli.ts` (it depends on `import.meta.url` context).
- `import.meta.url` works correctly in tsdown’s ESM output (`format: 'esm'` in
  `tsdown.config.ts`). Verified: tsdown preserves `import.meta.url` in `.mjs` output.
- The `copy-docs.mjs` script must run AFTER tsdown (which may `clean: true` the dist/
  directory). The chained build command `"tsdown && node scripts/copy-docs.mjs"` is
  correct because tsdown runs first and copy-docs adds to its output.
- `--brief` mode always uses the separate `blobsy-docs-brief.md` file.
  If `--brief` is combined with a `[topic]` argument, ignore the topic (brief is the
  whole condensed doc).
- No `github-slugger` dependency needed — the spec uses a regex for slugification.

#### 4b. New Markdown Output Utility

- [ ] **`packages/blobsy/src/markdown-output.ts`** — New file.
  Adapted from tbd’s `cli/lib/output.ts:197-336`. Three exported functions:

```typescript
/**
 * Markdown rendering and pagination for CLI documentation output.
 *
 * Adapted from tbd's output patterns:
 * - TTY: colorized markdown via marked-terminal, paginated with less -R
 * - Piped/non-TTY: plain markdown, no ANSI codes, no pagination
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { spawn } from 'node:child_process';

const MAX_WIDTH = 88;
const PAGINATION_THRESHOLD = 40; // lines before we paginate

function getTerminalWidth(): number {
  return Math.min(MAX_WIDTH, process.stdout.columns ?? 80);
}

/** True when stdout is a TTY and --json/--quiet are not set. */
export function isInteractive(opts: Record<string, unknown>): boolean {
  return !opts.json && !opts.quiet && process.stdout.isTTY === true;
}

/**
 * Render markdown to colorized terminal output.
 * Returns plain markdown when not interactive.
 */
export function renderMarkdown(content: string, interactive: boolean): string {
  if (!interactive) {
    return content;
  }
  marked.use(
    markedTerminal({
      width: getTerminalWidth(),
      reflowText: true,
    }) as unknown as Parameters<typeof marked.use>[0],
  );
  return marked.parse(content) as string;
}

/**
 * Output content, paginating through less -R if interactive and long.
 * Falls back to console.log if pager is unavailable.
 */
export async function paginateOutput(
  content: string,
  interactive: boolean,
): Promise<void> {
  const lines = content.split('\n').length;

  if (!interactive || lines < PAGINATION_THRESHOLD || !process.stdout.isTTY) {
    console.log(content);
    return;
  }

  const pager = process.env.PAGER ?? 'less -R';
  const [cmd, ...args] = pager.split(' ');

  return new Promise((resolve) => {
    const child = spawn(cmd!, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') return; // user quit pager early — fine
    });

    child.stdin.write(content);
    child.stdin.end();

    child.on('close', () => resolve());
    child.on('error', () => {
      console.log(content); // fallback if pager unavailable
      resolve();
    });
  });
}
```

#### 4c. New Documentation Source Files

- [ ] **`packages/blobsy/docs/`** — New directory for bundled documentation

- [ ] **`packages/blobsy/docs/blobsy-docs.md`** — User guide (the `blobsy docs` source).
  Organized with `##` section headers for extraction.
  Content outline (~250 lines):

```markdown
# blobsy User Guide

For command reference, run `blobsy --help` or `blobsy <command> --help`.

## Conceptual Model

Blobsy tracks large files with lightweight `.bref` pointer files committed to Git.
The actual data (blobs) lives in remote storage — S3, local directories, or custom
command backends.

The lifecycle:
1. `blobsy track <file>` — hashes the file, writes a `.bref` pointer, gitignores original
2. `blobsy push` — uploads the blob to remote, records `remote_key` in `.bref`
3. `blobsy pull` — downloads blobs using `.bref` metadata

Content-addressable storage: SHA-256 hashing means identical files produce the same
blob. Pushing the same content twice is a no-op.

## Configuration

Configuration lives in `.blobsy.yml` files. Five levels, bottom-up resolution:

  (blobsy built-in defaults)           Hardcoded in blobsy
  ~/.blobsy.yml                        User-global defaults
  <repo>/.blobsy.yml                   Repo root
  <repo>/data/.blobsy.yml              Subdirectory override
  <repo>/data/raw/.blobsy.yml          Deeper override

Merge semantics: shallow replace (not deep-merge). A subdirectory config replaces
the entire array/object, not individual elements.

Important: Settings affecting remote storage (compression algorithm, checksum)
must be in repo-level config (committed to git), not user-global config.

## Built-in Defaults
[full YAML block from config.ts getBuiltinDefaults()]

## Externalization Rules

When tracking a directory (`blobsy track <dir>` or `blobsy track .`), blobsy decides
per-file whether to externalize. Rules checked in order:

1. `never` patterns (highest priority) — matching files stay in git
2. `always` patterns — matching files externalized regardless of size
3. `min_size` threshold (default: 200kb) — files at or above this size externalized

When tracking a specific file by name, it is always externalized (rules bypassed).

[YAML example of externalize config]

## Compression

Blobsy compresses blobs before upload and decompresses on pull.
Algorithms: zstd (default), gzip, brotli, or none.

[YAML example of compress config]

The compression config must be in repo-level .blobsy.yml because it affects
remote keys.

## Ignore Patterns

Files matching `ignore` patterns are skipped by `blobsy track`.
Same syntax as .gitignore.

[built-in defaults listed]

## Backend Configuration

Three backend types:

### S3 (and S3-compatible)
[YAML examples for standard S3 and S3-compatible with endpoint]

### Local Directory
[YAML example]

### Custom Command
[YAML example with template variables {local}, {remote}]

### Environment Override
  export BLOBSY_BACKEND_URL=s3://ci-bucket/cache/

### Remote Key Templates
[default template + alternative templates]

## CI Integration

### Pre-push Check
[workflow: track → commit .bref → push → git push → CI runs pre-push-check]

### Syncing in CI
  blobsy pull
  blobsy verify

### Environment Override
  export BLOBSY_BACKEND_URL=s3://ci-bucket/cache/

## Common Workflows

### Track and Push
  blobsy track data/model.bin
  blobsy push
  git add -A && git commit -m "Track model"

### Pull After Clone
  blobsy pull
  blobsy verify

### Diagnostics
  blobsy doctor --json
  blobsy status --json

### Backend Migration
  # Edit .blobsy.yml with new backend URL, then:
  blobsy push --force
```

- [ ] **`packages/blobsy/docs/blobsy-docs-brief.md`** — Condensed user guide (~80
  lines). Key points without YAML examples.
  Ends with “For full documentation: `blobsy docs`”

#### 4d. Build Script for Doc Bundling

- [ ] **`packages/blobsy/scripts/copy-docs.mjs`** — New file.
  Adapted from tbd’s `scripts/copy-docs.mjs` but much simpler (blobsy has fewer docs).
  Runs at postbuild to copy docs to `dist/docs/`:

```javascript
#!/usr/bin/env node
/**
 * Copy documentation files to dist/docs/ for bundled CLI.
 *
 * Adapted from tbd's copy-docs.mjs pattern.
 * Source: packages/blobsy/docs/ → dist/docs/
 * Also copies README.md from repo root.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const repoRoot = join(pkgRoot, '..', '..');

const distDocs = join(pkgRoot, 'dist', 'docs');
mkdirSync(distDocs, { recursive: true });

// Copy packaged docs
const DOCS = ['blobsy-docs.md', 'blobsy-docs-brief.md'];
for (const filename of DOCS) {
  const content = readFileSync(join(pkgRoot, 'docs', filename), 'utf-8');
  writeFileSync(join(distDocs, filename), content);
}

// Copy README.md from repo root
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
writeFileSync(join(distDocs, 'README.md'), readme);
```

- [ ] **`packages/blobsy/package.json`** — Update `scripts.build` to run copy-docs after
  tsdown:

```json
"build": "tsdown && node scripts/copy-docs.mjs"
```

#### 4e. Command: `blobsy readme`

- [ ] **`packages/blobsy/src/cli.ts`** — Register `readme` command (before
  `skill`/`prime`, after `pre-push-check`). Pattern follows tbd’s `readme.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// (readFile already imported; fileURLToPath + dirname need adding)

import {
  isInteractive,
  renderMarkdown,
  paginateOutput,
} from './markdown-output.js';

// ... inside createProgram():

  program
    .command('readme')
    .description('Display the blobsy README')
    .action(
      wrapAction(async (opts: Record<string, unknown>) => {
        const content = await loadBundledDoc('README.md');
        const interactive = isInteractive(opts);
        const rendered = renderMarkdown(content, interactive);
        await paginateOutput(rendered, interactive);
      }),
    );
```

With a helper function (can be in `markdown-output.ts` or inline in cli.ts):

```typescript
/**
 * Load a bundled documentation file from dist/docs/ with dev fallback.
 * Pattern from tbd's readme.ts / docs.ts.
 */
async function loadBundledDoc(filename: string): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Production: dist/docs/<filename>
  try {
    return await readFile(join(__dirname, 'docs', filename), 'utf-8');
  } catch {
    // Dev fallback: packages/blobsy/docs/<filename>
    try {
      return await readFile(join(__dirname, '..', 'docs', filename), 'utf-8');
    } catch {
      // Last fallback for README: repo root
      if (filename === 'README.md') {
        return await readFile(
          join(__dirname, '..', '..', '..', 'README.md'),
          'utf-8',
        );
      }
      throw new Error(`Documentation file not found: ${filename}`);
    }
  }
}
```

#### 4f. Command: `blobsy docs`

- [ ] **`packages/blobsy/src/cli.ts`** — Register `docs` command with topic argument and
  `--list`/`--brief` flags.
  Section extraction follows tbd’s `docs.ts` pattern:

```typescript
  program
    .command('docs')
    .description('Display blobsy user documentation')
    .argument('[topic]', 'Section to display (e.g. "compression", "backends")')
    .option('--list', 'List available sections')
    .option('--brief', 'Condensed version')
    .action(
      wrapAction(async (topic: string | undefined, opts: Record<string, unknown>) => {
        const interactive = isInteractive(opts);

        // Brief mode: load condensed docs
        if (opts.brief) {
          const brief = await loadBundledDoc('blobsy-docs-brief.md');
          const rendered = renderMarkdown(brief, interactive);
          await paginateOutput(rendered, interactive);
          return;
        }

        let content = await loadBundledDoc('blobsy-docs.md');

        // Extract sections from ## headers
        const sections = extractSections(content);

        // --list: enumerate available sections
        if (opts.list) {
          console.log('Available documentation sections:\n');
          for (const s of sections) {
            console.log(`  ${s.slug.padEnd(28)} ${s.title}`);
          }
          console.log(`\nUse: blobsy docs <topic>`);
          return;
        }

        // Filter to specific section if topic given
        if (topic) {
          const section = findSection(content, sections, topic);
          if (!section) {
            console.error(
              `Section "${topic}" not found. Use --list to see available sections.`,
            );
            process.exitCode = 1;
            return;
          }
          content = section;
        }

        const rendered = renderMarkdown(content, interactive);
        await paginateOutput(rendered, interactive);
      }),
    );
```

With section extraction helpers (in `markdown-output.ts`):

```typescript
export interface DocSection {
  title: string;
  slug: string;
}

/** Extract ## section headers and slugified IDs from markdown. */
export function extractSections(content: string): DocSection[] {
  const sections: DocSection[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      sections.push({ title, slug });
    }
  }
  return sections;
}

/** Find and extract a section by slug or partial title match. */
export function findSection(
  content: string,
  sections: DocSection[],
  query: string,
): string | null {
  const lower = query.toLowerCase();
  const match =
    sections.find((s) => s.slug === lower) ??
    sections.find((s) => s.title.toLowerCase().includes(lower));
  if (!match) return null;

  const lines = content.split('\n');
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) break;
      if (line.slice(3).trim() === match.title) {
        inSection = true;
        result.push(line);
      }
    } else if (inSection) {
      result.push(line);
    }
  }

  // Trim trailing blank lines
  while (result.length > 0 && result[result.length - 1]?.trim() === '') {
    result.pop();
  }

  return result.length > 0 ? result.join('\n') : null;
}
```

Note: tbd uses `github-slugger` for slugification.
For blobsy’s simpler needs, a regex replacement suffices (no need for the extra
dependency).

#### 4g. Test Changes

- [ ] **`packages/blobsy/tests/golden/commands/help.tryscript.md`** — Update:
  - `readme` and `docs` appear in top-level help command list (between `pre-push-check`
    and `skill`)
  - Add per-command help section: `blobsy readme --help` shows options (`-h, --help`)
  - Add per-command help section: `blobsy docs --help` shows `[topic]` argument,
    `--list`, `--brief` options

- [ ] **`packages/blobsy/tests/golden/commands/readme.tryscript.md`** — New golden test
  file. Uses `sandbox: true` (no git repo needed for doc output).
  Scenarios:
  - `blobsy readme | head -5`: verify output starts with `# blobsy` and includes the
    tagline
  - `blobsy readme | grep -c "##"`: verify multiple section headers present (confirms
    full README, not brief)
  - `blobsy readme | grep "Quick Start"`: verify Quick Start section is included

- [ ] **`packages/blobsy/tests/golden/commands/docs.tryscript.md`** — New golden test
  file. Uses `sandbox: true`. Comprehensive scenarios:
  - `blobsy docs --list`: verify section listing output includes section names like
    “Conceptual Model”, “Configuration”, “Externalization Rules”, “Compression”,
    “Backend Configuration”, etc.
    Verify footer shows `Use: blobsy docs <topic>`
  - `blobsy docs --brief | head -5`: verify condensed version starts with expected
    header content
  - `blobsy docs --brief | tail -1`: verify ends with “For full documentation:
    `blobsy docs`”
  - `blobsy docs compression | head -3`: verify section extraction returns the
    Compression section header
  - `blobsy docs backends | head -3`: verify partial-title matching works (matches
    “Backend Configuration”)
  - `blobsy docs nonexistent-section`: verify error message `Section
    "nonexistent-section" not found.
    Use --list to see available sections.` and exit code 1
  - `blobsy docs | head -5`: verify full docs output starts with `# blobsy User Guide`

- [ ] **`packages/blobsy/tests/markdown-output.test.ts`** — Unit tests for pure
  functions (no I/O, no golden format needed):
  - `extractSections()`: given markdown with `## Foo`, `## Bar Baz`, returns
    `[{title: "Foo", slug: "foo"}, {title: "Bar Baz", slug: "bar-baz"}]`
  - `extractSections()`: ignores `#` and `###` headers (only `##`)
  - `extractSections()`: handles special characters in titles (e.g.
    `## S3 (and S3-compatible)` → slug `s3-and-s3-compatible`)
  - `findSection()`: exact slug match returns section content up to next `##`
  - `findSection()`: partial title match works (e.g. query “compress” matches
    “Compression”)
  - `findSection()`: returns `null` for no match
  - `findSection()`: trailing blank lines are trimmed from extracted section
  - `renderMarkdown()`: with `interactive=false` returns content unchanged (plain
    markdown)
  - `isInteractive()`: returns `false` when `opts.json` is set
  - `isInteractive()`: returns `false` when `opts.quiet` is set

#### 4h. Documentation Changes

- [ ] **`README.md`** — Add `readme` and `docs` to the Commands table (before `skill`
  row):

```markdown
| `blobsy readme` | Display the README |
| `blobsy docs [topic]` | Display user documentation (use `--list` for sections) |
```

- [ ] **`CHANGELOG.md`** — Add “Added” entry: `readme` and `docs` commands
- [ ] **`docs/project/design/current/blobsy-design.md`** — Add DOCUMENTATION category to
  Command Summary (before AGENT INTEGRATION):

```
DOCUMENTATION
  blobsy readme                        Display the README
  blobsy docs [topic] [--list|--brief] Display user documentation
```

### Phase 5: Colored Help Output and CLI Polish

Add `picocolors` for colored help text, command groups for organized `--help` output,
and `showHelpAfterError()` for better error UX. Follows tbd’s patterns
(`attic/tbd/packages/tbd/src/cli/lib/output.ts:106-150`).

**Implementation notes:**

- Commander v14.0.3 supports `styleTitle`, `styleCommandText`, `styleOptionText` as
  direct properties on the `configureHelp()` options object (no Help subclass needed).
  These replace the `formatHelp` callback entirely — remove the entire custom function
  at `cli.ts:86-160`.
- Setting `showGlobalOptions: true` causes `--json`, `--quiet`, `--verbose`, `--dry-run`
  to appear in EVERY per-command `--help` output (under a “Global Options:” section).
  Currently `false`, so they only appear in `blobsy --help`. This is intentional — users
  should see the full option set per command.
- The epilog uses `program.addHelpText('after', ...)` which is a SEPARATE API from
  `configureHelp()`. Both are needed: `configureHelp()` handles the main help body,
  `addHelpText('after', ...)` appends the footer.
  The epilog only fires for top-level `blobsy --help` because it’s on `program`, not on
  subcommands.
- The old epilog at `cli.ts:147-156` references `blobsy track` and the GitHub URL. The
  new epilog intentionally replaces `track` with `add` (the recommended command) and
  dims the URL in favor of `blobsy readme`/`blobsy docs` as the primary discovery path.
- For golden tests: `NO_COLOR=1` should be set in the `env:` frontmatter of help-related
  golden tests only (help.tryscript.md, help-error.tryscript.md).
  Other golden tests don’t produce colored output unless they invoke `--help`.

#### 5a. New Dependency

- [ ] **`packages/blobsy/package.json`** — Add to `dependencies`:

```json
"picocolors": "^1.1.0"
```

Note: `picocolors` is tiny (3.8KB, no deps) and handles `NO_COLOR`/`FORCE_COLOR`
automatically. Preferred over `chalk` per tbd guidelines.

#### 5b. Replace Custom `formatHelp` with Commander v14 Styled Help

- [ ] **`packages/blobsy/src/cli.ts:86-160`** — Replace the entire custom `formatHelp`
  function with Commander v14’s built-in styled help via `configureHelp()`. The current
  custom implementation manually builds help text with hardcoded padding.
  Replace with:

```typescript
import colors from 'picocolors';

// ... inside createProgram(), replace .configureHelp({...}) with:

  .configureHelp({
    helpWidth: Math.min(88, process.stdout.columns ?? 80),
    showGlobalOptions: true,
    styleTitle: (str: string) => colors.bold(colors.cyan(str)),
    styleCommandText: (str: string) => colors.green(str),
    styleOptionText: (str: string) => colors.yellow(str),
  })
```

This removes ~70 lines of custom formatting code and replaces it with Commander’s
built-in styled output, which handles arguments, options, commands, and global options
correctly.

#### 5c. `showHelpAfterError()` for Better Error UX

- [ ] **`packages/blobsy/src/cli.ts`** — Add after `.configureHelp(...)`:

```typescript
  .showHelpAfterError('(use --help for usage, or blobsy docs for full guide)')
```

This tells users how to get help when they mistype a command or forget required args.
It points to both `--help` for immediate command usage and `blobsy docs` for the full
user guide.

#### 5d. Colored Epilog

- [ ] **`packages/blobsy/src/cli.ts`** — Add a colored epilog using `addHelpText()`. The
  footer should strongly encourage users and agents to use `blobsy readme` and
  `blobsy docs` as the primary way to learn about blobsy:

```typescript
  program.addHelpText('after', () => {
    return [
      '',
      colors.bold('Get started:'),
      `  ${colors.green('blobsy init')} s3://bucket/prefix/`,
      `  ${colors.green('blobsy add')} <file-or-dir>`,
      `  ${colors.green('blobsy push')}`,
      '',
      colors.bold('Learn more:'),
      `  ${colors.green('blobsy readme')}              Overview and quick start`,
      `  ${colors.green('blobsy docs')}                Full user guide`,
      `  ${colors.green('blobsy docs')} ${colors.yellow('<topic>')}        Specific topic (try ${colors.yellow('"backends"')}, ${colors.yellow('"compression"')})`,
      `  ${colors.green('blobsy docs --list')}          List all topics`,
      '',
      `${colors.dim('https://github.com/jlevy/blobsy')}`,
    ].join('\n');
  });
```

This replaces the current hardcoded epilog inside the custom `formatHelp` function.
The “Learn more” block makes `readme` and `docs` the primary discovery path for both
humans and agents. The URL is dimmed rather than prominent — the CLI docs commands are
the preferred way to access documentation.

#### 5e. Command Groups (Optional — Investigate Compatibility)

- [ ] **`packages/blobsy/src/cli.ts`** — Investigate whether Commander v14’s
  `commandsGroup()` works with inline `.command()` registration (blobsy’s current
  pattern). If it does, organize commands into groups matching the design doc categories:

```typescript
  // If commandsGroup() works with inline .command():
  program.command('init')
    .commandsGroup('Setup')
    .description('Initialize blobsy in a git repo with a backend URL')
    // ...

  // If commandsGroup() only works with .addCommand():
  // Refactor to addCommand() pattern or skip grouping for initial release
```

If `commandsGroup()` doesn’t work with inline `.command()`, defer to a future release.
The colored help from Phase 5b-5d still provides substantial polish without groups.

#### 5f. Test Changes

**Important:** All golden tests should set `NO_COLOR=1` in their `env:` frontmatter to
suppress ANSI escape codes, producing deterministic plain-text output for comparison.
The existing golden tests already run without colors because tryscript likely doesn’t
allocate a TTY, but setting `NO_COLOR=1` explicitly is more robust.
Verify this during implementation and apply `NO_COLOR=1` to all golden tests if needed.

- [ ] **`packages/blobsy/tests/golden/commands/help.tryscript.md`** — Update golden
  test:
  - Verify that `showGlobalOptions: true` causes global options (`--json`, `--quiet`,
    `--verbose`, `--dry-run`) to appear in per-command help output (they previously
    didn’t because `showGlobalOptions` was `false`)
  - Update all per-command help sections to include the global options block
  - Verify the epilog on top-level `blobsy --help` includes the “Learn more” block with
    `blobsy readme`, `blobsy docs`, `blobsy docs <topic>`, and `blobsy docs --list`
  - Verify the epilog includes `blobsy add` (not `blobsy track`) as the get-started
    command

- [ ] **`packages/blobsy/tests/golden/commands/help-error.tryscript.md`** — New golden
  test file. Uses `sandbox: true`. Scenarios:
  - `blobsy badcommand`: verify stderr contains `error: unknown command 'badcommand'`
    and the help hint `(use --help for usage, or blobsy docs for full guide)`. Exit code
    1\.
  - `blobsy track`: verify stderr contains error about missing required argument `path`
    and the help hint. Exit code 1.
  - `blobsy init`: verify stderr contains error about missing required argument `url`
    and the help hint. Exit code 1.

#### 5g. Documentation Changes

- [ ] **`docs/project/design/current/blobsy-design.md`** — No structural changes needed
  (colored help is a presentation concern, not a design change).
  Optionally add a note in the CLI Interaction section about colored output.

- [ ] **`CHANGELOG.md`** — Add “Improved” entry: colored help output with styled
  commands, options, and section headers; better error messages with help hints

### Phase 6: Implement Git Hooks (Pre-Commit Validation + Pre-Push Auto-Push)

**Current state:** The pre-commit hook is installed by `blobsy init` and
`blobsy hooks install`, but `handleHook('pre-commit')` at `commands-stage2.ts:729-738`
is a no-op that immediately returns.
No pre-push hook exists.
The design doc (lines 2441-2456, 2735-2758) specifies auto-push on commit, but we’re
correcting this to pre-push (better UX — commits stay fast and offline-capable).

**Design:** Two hooks with corresponding responsibilities:

| Hook | Git event | Blobsy action | Speed |
| --- | --- | --- | --- |
| **pre-commit** | `git commit` | Verify staged `.bref` files have valid hashes (local file matches `.bref` hash) | Fast (local I/O only) |
| **pre-push** | `git push` | Run `blobsy push` for all unpushed `.bref` files | May upload (network) |

This creates a natural correspondence:
- **Commit time** = sanity check (did the file change after tracking?)
- **Push time** = ensure blobs and refs travel together

Both hooks are **optional but installed by default**. Users can:
- Skip during init: `blobsy init --no-hooks s3://...`
- Disable at runtime: `BLOBSY_NO_HOOKS=1 git commit` / `git push`
- Bypass per-invocation: `git commit --no-verify` / `git push --no-verify`
- Remove entirely: `blobsy hooks uninstall`

#### 6a. Pre-commit hook: Hash verification

- [ ] **`packages/blobsy/src/commands-stage2.ts:729-738`** — Replace the no-op
  `handleHook('pre-commit')` with hash verification logic:

  ```typescript
  async function handlePreCommitHook(repoRoot: string): Promise<void> {
    // Find staged .bref files
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
      { cwd: repoRoot, encoding: 'utf-8' })
      .trim().split('\n').filter(f => f.endsWith(BREF_EXTENSION));

    if (staged.length === 0) return;

    const failures: string[] = [];
    for (const brefRelPath of staged) {
      const brefAbsPath = join(repoRoot, brefRelPath);
      const ref = await readBref(brefAbsPath);
      const dataPath = stripBrefExtension(brefAbsPath);

      if (!existsSync(dataPath)) {
        // Data file missing is OK — it may have been gitignored and deleted
        continue;
      }

      const actualHash = await computeHash(dataPath);
      if (actualHash !== ref.hash) {
        failures.push(stripBrefExtension(brefRelPath));
      }
    }

    if (failures.length > 0) {
      console.error('blobsy pre-commit: hash mismatch detected.');
      console.error('The following files were modified after tracking:\n');
      for (const f of failures) {
        console.error(`  ${f}`);
      }
      console.error('\nRe-run `blobsy track` (or `blobsy add`) to update the .bref files.');
      console.error('To bypass: git commit --no-verify');
      process.exitCode = 1;
    }
  }
  ```

#### 6b. Pre-push hook: Auto-push blobs

- [ ] **`packages/blobsy/src/commands-stage2.ts`** — Add `handlePrePushHook()`:

  ```typescript
  async function handlePrePushHook(repoRoot: string): Promise<void> {
    const config = await resolveConfig(repoRoot, repoRoot);
    const allBrefs = findBrefFiles(repoRoot, repoRoot);
    const unpushed: string[] = [];

    for (const relPath of allBrefs) {
      const refPath = join(repoRoot, brefPath(relPath));
      const ref = await readBref(refPath);
      if (!ref.remote_key) {
        unpushed.push(relPath);
      }
    }

    if (unpushed.length === 0) return;

    console.log(`blobsy pre-push: uploading ${unpushed.length} blob${unpushed.length === 1 ? '' : 's'}...`);

    // Reuse the existing push logic (handlePush internals)
    for (const relPath of unpushed) {
      await pushSingleFile(relPath, repoRoot, config, { quiet: false, json: false });
    }

    console.log('blobsy pre-push: all blobs uploaded.');
  }
  ```

  **`pushSingleFile()` extraction:** There is NO existing `pushSingleFile()` function.
  The current `handlePush()` in `commands-stage2.ts:81-155` iterates over `.bref` files
  and calls `pushFile()` (line 143) from `transfer.ts` for each one.
  Extract the per-file push logic into a new function:

  ```typescript
  async function pushSingleFile(
    relPath: string,
    repoRoot: string,
    config: BlobsyConfig,
    opts: { quiet: boolean; json: boolean },
  ): Promise<void> {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);
    const dataPath = join(repoRoot, relPath);
    // Reuse the existing pushFile() from transfer.ts
    const result = await pushFile(dataPath, ref, config);
    if (result.remote_key) {
      ref.remote_key = result.remote_key;
      await writeBref(refPath, ref);
    }
    if (!opts.quiet && !opts.json) {
      console.log(`  pushed: ${relPath}`);
    }
  }
  ```

  The exact parameters and logic should mirror the per-file loop in `handlePush()`.
  Check `commands-stage2.ts:130-150` for the precise data flow.

  **Hook manager detection behavior:** When lefthook.yml or .husky is detected,
  `installHooks()` prints guidance and SKIPS file installation.
  This is intentional — installing directly to `.git/hooks/` would conflict with the
  hook manager. Users must add `blobsy hook pre-commit` and `blobsy hook pre-push` to
  their hook manager config.

  **`--no-hooks` on init:** This is a one-time skip for this invocation only, NOT a
  persistent setting. A subsequent `blobsy hooks install` will still install hooks.

- [ ] **`packages/blobsy/src/commands-stage2.ts:729-738`** — Expand `handleHook()` to
  dispatch both hook types:

  ```typescript
  export async function handleHook(
    type: string,
    _opts: Record<string, unknown>,
    _cmd: Command,
  ): Promise<void> {
    if (process.env.BLOBSY_NO_HOOKS) return;

    const repoRoot = findRepoRoot();

    if (type === 'pre-commit') {
      await handlePreCommitHook(repoRoot);
    } else if (type === 'pre-push') {
      await handlePrePushHook(repoRoot);
    } else {
      throw new ValidationError(`Unknown hook type: ${type}`);
    }
  }
  ```

#### 6c. Hook installation — both hooks + `--no-hooks`

- [ ] **`packages/blobsy/src/cli.ts:461-501`** — Update `installStubHook()` to install
  **both** pre-commit and pre-push hooks.
  Rename to `installHooks()`:

  ```typescript
  const HOOKS = [
    { name: 'pre-commit', gitEvent: 'pre-commit' },
    { name: 'pre-push', gitEvent: 'pre-push' },
  ] as const;

  async function installHooks(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
    if (process.env.BLOBSY_NO_HOOKS) return;

    const hookDir = join(repoRoot, '.git', 'hooks');

    // Check for hook managers
    if (existsSync(join(repoRoot, 'lefthook.yml')) || existsSync(join(repoRoot, '.husky'))) {
      if (!globalOpts.quiet && !globalOpts.json) {
        console.log('Hook manager detected. Add blobsy hooks to your hook configuration:');
        console.log('  pre-commit: blobsy hook pre-commit');
        console.log('  pre-push:   blobsy hook pre-push');
      }
      return;
    }

    await ensureDir(hookDir);
    const { writeFile: writeFs, chmod } = await import('node:fs/promises');

    for (const hook of HOOKS) {
      const hookPath = join(hookDir, hook.name);

      if (existsSync(hookPath)) {
        const content = await readFile(hookPath, 'utf-8');
        if (!content.includes('blobsy')) {
          if (!globalOpts.quiet && !globalOpts.json) {
            console.log(`Existing ${hook.name} hook found. Add manually: blobsy hook ${hook.gitEvent}`);
          }
          continue;
        }
      }

      const hookContent = `#!/bin/sh\n# Installed by: blobsy hooks install\n# To bypass: git ${hook.name === 'pre-commit' ? 'commit' : 'push'} --no-verify\nexec blobsy hook ${hook.gitEvent}\n`;
      await writeFs(hookPath, hookContent);
      await chmod(hookPath, 0o755);

      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(`Installed ${hook.name} hook.`);
      }
    }
  }
  ```

- [ ] **`packages/blobsy/src/cli.ts:163-167`** — Add `--no-hooks` option to `init`:

  ```typescript
  program
    .command('init')
    .description('Initialize blobsy in a git repo with a backend URL')
    .argument('<url>', 'Backend URL (e.g. s3://bucket/prefix/, local:../path)')
    .option('--region <region>', 'AWS region (for S3 backends)')
    .option('--no-hooks', 'Skip git hook installation')
    .action(wrapAction(handleInit));
  ```

- [ ] **`packages/blobsy/src/cli.ts:457-458`** — Pass `--no-hooks` through to skip hook
  installation:

  ```typescript
  if (!opts.noHooks) {
    await installHooks(repoRoot, globalOpts);
  }
  ```

- [ ] **`packages/blobsy/src/cli.ts:274-277`** — Update hidden `hook` command to accept
  `pre-push` as well:

  ```typescript
  program
    .command('hook', { hidden: true })
    .description('Internal hook commands')
    .argument('<type>', 'Hook type (pre-commit, pre-push)')
    .action(wrapAction(handleHook));
  ```

#### 6d. `blobsy hooks` command — manage both hooks

- [ ] **`packages/blobsy/src/commands-stage2.ts:562-643`** — Update `handleHooks()` to
  install/uninstall both hooks.
  Change the loop to iterate over both `pre-commit` and `pre-push` hook paths.
  Update uninstall to check both.

- [ ] **`packages/blobsy/src/cli.ts:258-261`** — Update description:

  ```typescript
  program
    .command('hooks')
    .description('Install or uninstall blobsy git hooks (pre-commit, pre-push)')
    .argument('<action>', 'install or uninstall')
    .action(wrapAction(handleHooks));
  ```

#### 6e. Test Changes

**Existing files that need modification:**

- [ ] **`packages/blobsy/tests/hooks.test.ts`** — Currently tests pre-commit hook only
  (8 tests: absolute path, hashbang, comments, execution, uninstall, invalid action,
  path detection, idempotent install).
  All assertions reference only `pre-commit` and `hookPath` points to
  `.git/hooks/pre-commit`. Changes needed:
  - Add `prePushHookPath` pointing to `.git/hooks/pre-push`
  - Update “should write absolute path” test to verify both hooks
  - Update “should use hashbang and be executable” test for both hooks
  - Update “should include installation comments” — pre-push hook should say
    `To bypass: git push --no-verify` (not `git commit --no-verify`)
  - Update “should uninstall hook correctly” to verify both hooks removed
  - Update “should work even if installed multiple times” to check both hooks
  - Add new test: `--no-hooks` on init skips hook installation
  - Add new test: `BLOBSY_NO_HOOKS=1` env var skips hook execution

- [ ] **`packages/blobsy/tests/golden/commands/hooks.tryscript.md`** — Currently tests
  pre-commit only: install (1 message), verify executable, verify content, uninstall (1
  message), no-op uninstall, non-blobsy hook detection, hook execution via commit.
  Changes needed:
  - Install output should show two messages: “Installed pre-commit hook.”
    and “Installed pre-push hook.”
  - Add `test -x .git/hooks/pre-push && echo "executable"` verification
  - Add `head -2 .git/hooks/pre-push` content verification
  - Uninstall should show: “Uninstalled pre-commit hook.”
    and “Uninstalled pre-push hook.”
  - No-op uninstall should show: “No pre-commit hook found.”
    and “No pre-push hook found.”
  - Non-blobsy hook test: existing custom hook on one type shouldn’t block the other
  - Hook manager detection test: with `lefthook.yml` present, `blobsy hooks install`
    should print guidance messages ("Add blobsy hooks to your hook configuration:") and
    not create hook files

- [ ] **`packages/blobsy/tests/golden/commands/init.tryscript.md`** — Currently uses
  `BLOBSY_NO_HOOKS: "1"` in env to suppress hooks entirely.
  Changes needed:
  - Add test without `BLOBSY_NO_HOOKS`: default `blobsy init` installs both hooks,
    verify with `test -x .git/hooks/pre-commit` and `test -x .git/hooks/pre-push`
  - Add test with `--no-hooks`: `blobsy init --no-hooks local:../remote` should succeed
    but no hook files created
  - Keep existing tests with `BLOBSY_NO_HOOKS: "1"` for backward compatibility

- [ ] **`packages/blobsy/tests/golden/commands/help.tryscript.md`** — Currently shows
  `hooks <action>` described as “Install or uninstall the blobsy pre-commit hook” and
  init `--help` does not show `--no-hooks`. Changes needed:
  - Update hooks description to mention both hooks: “Install or uninstall blobsy git
    hooks (pre-commit, pre-push)”
  - Update init `--help` to show `--no-hooks` option
  - Per-command help for hooks should reflect both hook types

**New test files:**

- [ ] **`packages/blobsy/tests/golden/commands/pre-commit-hook.tryscript.md`** — New
  golden test:
  - Track a file, modify it after tracking, attempt commit: verify hook rejects with
    hash mismatch error and lists the file
  - Track a file, don’t modify: verify commit succeeds silently
  - Commit with `--no-verify`: verify hook is bypassed
  - `BLOBSY_NO_HOOKS=1 git commit`: verify hook is bypassed

- [ ] **`packages/blobsy/tests/golden/commands/pre-push-hook.tryscript.md`** — New
  golden test (requires a local backend to avoid real S3 calls):
  - Track and commit a file without pushing blobs, then `git push`: verify hook
    auto-pushes the blob before refs are pushed
  - All blobs already pushed: verify hook completes silently
  - `BLOBSY_NO_HOOKS=1 git push`: verify hook is bypassed

#### 6f. Documentation Changes

- [ ] **`README.md`** — Add a “Git Hooks” section (after Externalization Rules, before
  Compression) explaining:
  - Pre-commit: validates `.bref` hashes (catches files modified after tracking)
  - Pre-push: auto-uploads blobs (ensures blobs arrive with refs)
  - Installed by default, opt out with `--no-hooks`, `--no-verify`, or
    `BLOBSY_NO_HOOKS=1`
  - Hook manager users: add `blobsy hook pre-commit` and `blobsy hook pre-push` to their
    config

- [ ] **`README.md`** — Update Commands table: `blobsy hooks <action>` description to
  mention both hooks

- [ ] **`README.md`** — Update Quick Start to show the full workflow including push:

  ```bash
  blobsy add data/
  git commit -m "Track large files"
  blobsy push          # or just `git push` (pre-push hook auto-uploads)
  git push
  ```

- [ ] **`packages/blobsy/SKILL.md`** — Update hooks section

- [ ] **`CHANGELOG.md`** — Add “Added” entries:
  - Pre-commit hook validates `.bref` hashes
  - Pre-push hook auto-uploads blobs
  - `blobsy init --no-hooks` to skip hook installation

- [ ] **`docs/project/design/current/blobsy-design.md`** — Update:
  - Change pre-commit hook description from “auto-pushes blobs” to “validates hashes”
  - Add pre-push hook to the hook management section
  - Update the conflict detection strategy section (lines 2439-2456) to reflect the
    two-hook design
  - Add `--no-hooks` to `blobsy init` options

### Phase 7: Enhance `blobsy config` with `--global`, `--show-origin`, and `--unset`

**Current state:** `blobsy config`
([cli.ts:1238-1355](packages/blobsy/src/cli.ts#L1238)) supports three modes:

- `blobsy config` — dumps raw repo `.blobsy.yml` (text) or resolved config (`--json`)
- `blobsy config <key>` — gets the effective (resolved) value for a dot-notation key
- `blobsy config <key> <value>` — sets a value in the repo-root `.blobsy.yml` only

The underlying `resolveConfig()` in
[config.ts:128-163](packages/blobsy/src/config.ts#L128) already walks the full 5-level
hierarchy (builtin → `~/.blobsy.yml` → repo root → subdirectories), but the CLI command
has no way to target a specific level for writes or to inspect where a value comes from.

**Design:** Follow `git config` conventions.
Git uses `--global`/`--local`/`--system` as “file-option” flags that control which file
is read from or written to.
Git uses `--show-origin` and `--show-scope` as “display-option” flags that annotate
output. We adopt the same pattern with blobsy’s config levels.

#### Scope mapping (git → blobsy)

| git scope | blobsy scope | File |
| --- | --- | --- |
| `--system` | (builtin) | Hardcoded in blobsy |
| `--global` | `--global` | `~/.blobsy.yml` |
| `--local` | (default) | `<repo>/.blobsy.yml` |
| `--worktree` | n/a | — |

Blobsy uses only two writable scopes (global and repo).
Subdirectory overrides are an advanced feature — writing to them requires specifying a
path, not a flag. For the initial release, `--global` is the only new scope flag;
repo-root remains the default.

**Implementation notes:**

- `blobsy config --global` works outside a git repo.
  The current `handleConfig()` always calls `findRepoRoot()` (line 1245). When
  `--global` is set AND no key/value requires repo context, skip `findRepoRoot()`:

  ```typescript
  const repoRoot = opts.global ? null : findRepoRoot();
  ```

  Then guard repo-dependent code paths with `if (repoRoot)`.

- `blobsy config` (without `--global`) from outside a git repo should error with the
  standard “Not in a blobsy repository” message (existing behavior).

- Precedence order (lowest to highest): builtin < global < repo.
  When both repo and global set the same key, repo wins.

- `--show-origin --json` with all keys returns an array:
  ```json
  {
    "schema_version": "0.1",
    "entries": [
      { "key": "externalize.min_size", "value": "200kb", "scope": "builtin", "file": null },
      { "key": "backends.default.url", "value": "local:remote", "scope": "repo", "file": ".blobsy.yml" }
    ]
  }
  ```

- `--unset` for a non-existent key: print nothing, exit 0 (idempotent, like git).

- `--unset` for a whole section (e.g. `--unset compress`): deletes the entire
  `compress:` block. Empty parent objects after deletion are harmless (no cleanup needed
  for initial release).

- `loadConfigFile()` in `config.ts:75` returns a partial `BlobsyConfig` — not all fields
  are present. `resolveConfigWithOrigins()` must preserve the partial nature to track
  which level set each key.

#### 7a. New flags on `blobsy config`

- [ ] **`packages/blobsy/src/cli.ts`** — Update config command registration:

  ```typescript
  program
    .command('config')
    .description('Show, get, or set .blobsy.yml values')
    .argument('[key]', 'Config key (dot-separated, e.g. compress.algorithm)')
    .argument('[value]', 'Value to set')
    .option('--global', 'Use user-global config (~/.blobsy.yml)')
    .option('--show-origin', 'Show where the value comes from (scope and file)')
    .option('--unset', 'Remove a key from the config file')
    .action(wrapAction(handleConfig));
  ```

#### 7b. `--global` flag for reads and writes

- [ ] **`packages/blobsy/src/cli.ts`** (`handleConfig`) — When `--global` is set:

  **Read (`blobsy config --global` or `blobsy config --global <key>`):** Load only
  `~/.blobsy.yml` (not the resolved/merged config).
  If the file doesn’t exist, show empty config or `(not set)`.

  **Write (`blobsy config --global <key> <value>`):** Write to `~/.blobsy.yml` instead
  of repo-root `.blobsy.yml`. Create the file if it doesn’t exist.

  ```typescript
  function getTargetConfigPath(
    repoRoot: string,
    opts: Record<string, unknown>,
  ): string {
    if (opts.global) {
      return join(homedir(), '.blobsy.yml');
    }
    return getConfigPath(repoRoot);
  }
  ```

  Important: `--global` does not require being inside a git repo for reads.
  For consistency, `blobsy config --global` should work from any directory (skip the
  `findRepoRoot()` call when `--global` is set and no repo-level access is needed).

#### 7c. `--show-origin` flag for reads

- [ ] **`packages/blobsy/src/cli.ts`** (`handleConfig`) — When `--show-origin` is set:

  **Single key (`blobsy config --show-origin <key>`):** Show the scope and file path of
  the winning value, tab-separated (matching git’s format):

  ```
  $ blobsy config --show-origin compress.algorithm
  builtin	zstd

  $ blobsy config --show-origin backends.default.url
  repo	.blobsy.yml	local:remote

  # If user overrides in ~/.blobsy.yml:
  $ blobsy config --show-origin compress.algorithm
  global	~/.blobsy.yml	gzip
  ```

  **All config (`blobsy config --show-origin`):** Show every effective key=value with
  its origin, one per line:

  ```
  $ blobsy config --show-origin
  builtin	externalize.min_size=200kb
  builtin	externalize.always=[]
  builtin	compress.algorithm=zstd
  builtin	compress.min_size=100kb
  repo	.blobsy.yml	backends.default.url=local:remote
  ```

  Implementation: Walk each config level separately and track which level last set each
  top-level key. This requires a new helper:

  ```typescript
  interface ConfigOrigin {
    scope: 'builtin' | 'global' | 'repo' | string;
    file?: string;
    config: BlobsyConfig;
  }

  async function resolveConfigWithOrigins(
    repoRoot: string,
  ): Promise<ConfigOrigin[]> {
    const origins: ConfigOrigin[] = [];

    origins.push({
      scope: 'builtin',
      config: getBuiltinDefaults(),
    });

    const globalPath = join(homedir(), '.blobsy.yml');
    if (existsSync(globalPath)) {
      origins.push({
        scope: 'global',
        file: '~/.blobsy.yml',
        config: await loadConfigFile(globalPath),
      });
    }

    const repoConfigPath = getConfigPath(repoRoot);
    if (existsSync(repoConfigPath)) {
      origins.push({
        scope: 'repo',
        file: '.blobsy.yml',
        config: await loadConfigFile(repoConfigPath),
      });
    }

    // Could add subdirectory configs here in the future

    return origins;
  }
  ```

  To find the origin of a specific key: walk the origins list in reverse (most specific
  first), check if the key exists in that level’s config, and return the first match.

  **JSON mode (`--show-origin --json`):**

  ```json
  {
    "schema_version": "0.1",
    "key": "compress.algorithm",
    "value": "zstd",
    "scope": "builtin",
    "file": null
  }
  ```

#### 7d. `--unset` flag

- [ ] **`packages/blobsy/src/cli.ts`** (`handleConfig`) — When `--unset` is set:

  ```bash
  blobsy config --unset compress.algorithm         # remove from repo config
  blobsy config --global --unset compress.algorithm # remove from global config
  ```

  Implementation: Load the target file, delete the nested key, write back.
  If the key doesn’t exist, print a message and exit 0 (idempotent, like git).

  ```typescript
  function unsetNestedValue(
    obj: Record<string, unknown>,
    path: string,
  ): boolean {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (typeof current[part] !== 'object' || current[part] === null) {
        return false; // path doesn't exist
      }
      current = current[part] as Record<string, unknown>;
    }
    const lastKey = parts[parts.length - 1]!;
    if (!(lastKey in current)) {
      return false;
    }
    delete current[lastKey];
    return true;
  }
  ```

  If the parent object becomes empty after deletion, optionally clean it up (e.g.
  removing `compress: {}` entirely).
  Not required for initial release — an empty section is harmless.

#### 7e. Improved `blobsy config` (no args) output

- [ ] **`packages/blobsy/src/cli.ts`** (`handleConfig`) — Currently, `blobsy config`
  with no args just dumps the raw `.blobsy.yml` file.
  This is confusing because it doesn’t show the effective (resolved) config — users see
  just what’s in their repo file, not the builtin defaults.

  Change behavior:
  - `blobsy config` (no args, no `--global`): show the **effective resolved config** as
    YAML. This matches what the `--json` mode already does (it calls `resolveConfig()`),
    making the text and JSON modes consistent.
  - `blobsy config --global` (no args): show only the contents of `~/.blobsy.yml` (just
    that one file, not resolved).

  This way, `blobsy config` answers the question “what is my effective configuration?”
  which is the most useful default.

#### 7f. Test Changes

**Existing files that need modification:**

- [ ] **`packages/blobsy/tests/golden/commands/config.tryscript.md`** — Currently tests:
  show all config (dumps raw file), show specific key, show `externalize` defaults, show
  `compress` defaults, show `remote` key template, set a value and verify.
  Changes needed:
  - Update `blobsy config` (no args) output — now shows resolved effective config
    instead of raw file contents.
    Verify it includes builtin defaults like `externalize`, `compress`, `ignore`, etc.
    even though they’re not in the `.blobsy.yml` file
  - Add `--global` tests:
    - `blobsy config --global`: no global config file → shows empty/message
    - `blobsy config --global compress.algorithm gzip`: creates `~/.blobsy.yml`, verify
      with `cat ~/.blobsy.yml`
    - `blobsy config --global compress.algorithm`: reads from global config
    - `blobsy config compress.algorithm`: still shows effective value (global overrides
      builtin)
  - Add `--show-origin` tests:
    - `blobsy config --show-origin compress.algorithm`: shows `builtin\tzstd`
    - After `blobsy config compress.algorithm zstd`:
      `blobsy config --show-origin compress.algorithm` shows `repo\t.blobsy.yml\tzstd`
    - After `blobsy config --global compress.algorithm gzip`:
      `blobsy config --show-origin compress.algorithm` shows
      `global\t~/.blobsy.yml\tgzip` (repo overrides global if both set, otherwise global
      wins over builtin)
    - `blobsy config --show-origin backends.default.url`: shows
      `repo\t.blobsy.yml\tlocal:remote`
    - `blobsy config --show-origin nonexistent.key`: shows `(not set)` with no origin
  - Add `--unset` tests:
    - `blobsy config compress.algorithm zstd` then `cat .blobsy.yml` (shows key present)
    - `blobsy config --unset compress.algorithm` then `cat .blobsy.yml` (key removed)
    - `blobsy config compress.algorithm`: still shows `zstd` (falls back to builtin)
    - `blobsy config --unset nonexistent.key`: no error, exits 0
    - `blobsy config --global --unset compress.algorithm`: removes from global config,
      verify with `cat ~/.blobsy.yml`

- [ ] **`packages/blobsy/tests/golden/json/config-json.tryscript.md`** — Currently tests
  `config --json` (shows full resolved config) and `config --json <key>` (shows
  key/value pair). Changes needed:
  - Add `--show-origin --json` test: verify JSON envelope includes `scope` and `file`
    fields
  - Add `--global --json` test: verify output contains only global config
  - Add `--unset --json` test: verify JSON message output
  - Existing `config --json` test should be unchanged (already shows resolved config)

- [ ] **`packages/blobsy/tests/golden/commands/help.tryscript.md`** — Update per-command
  help for config:
  - `blobsy config --help` should show `--global`, `--show-origin`, `--unset` options

**New test files:**

- [ ] **`packages/blobsy/tests/golden/commands/config-global.tryscript.md`** — New
  golden test focused on multi-level config interaction.
  Uses a custom `before:` that sets up both `~/.blobsy.yml` and repo `.blobsy.yml` to
  test precedence:
  - Set up: repo config has `backends.default.url`, global config has
    `compress.algorithm: gzip`
  - `blobsy config compress.algorithm`: shows `gzip` (global overrides builtin)
  - `blobsy config --show-origin compress.algorithm`: shows
    `global\t~/.blobsy.yml\tgzip`
  - `blobsy config compress.algorithm brotli` (set in repo): `cat .blobsy.yml` shows
    `compress.algorithm: brotli` added
  - `blobsy config --show-origin compress.algorithm`: now shows
    `repo\t.blobsy.yml\tbrotli` (repo wins over global)
  - `blobsy config --unset compress.algorithm`: `cat .blobsy.yml` shows key removed
  - `blobsy config --show-origin compress.algorithm`: falls back to
    `global\t~/.blobsy.yml\tgzip`
  - `blobsy config --global --unset compress.algorithm`: `cat ~/.blobsy.yml` shows key
    removed
  - `blobsy config --show-origin compress.algorithm`: falls back to `builtin\tzstd`

  Note: The `before:` block needs to handle creating `~/.blobsy.yml` carefully in the
  sandbox. If tryscript sandboxes the home directory, this works naturally.
  If not, use `HOME` env override to point to a temp directory.

- [ ] **`packages/blobsy/tests/golden/commands/config-show-origin.tryscript.md`** — New
  golden test for `--show-origin` with no key (list all effective values):
  - `blobsy config --show-origin`: shows all effective key=value lines with origins, one
    per line. Verify builtin keys appear with `builtin` scope, repo keys with `repo`
    scope
  - Verify output is tab-separated (scope, optional file, key=value)

- [ ] **`packages/blobsy/tests/golden/commands/config-global-no-repo.tryscript.md`** —
  New golden test verifying `--global` works outside a git repo:
  - Run `blobsy config --global compress.algorithm gzip` from a non-git directory:
    should succeed and write to `~/.blobsy.yml`
  - Run `blobsy config --global compress.algorithm` from a non-git directory: should
    return `gzip`
  - Run `blobsy config` (without `--global`) from a non-git directory: should error with
    “not a git repository” message

#### 7g. Documentation Changes

- [ ] **`README.md`** — Update the Commands table description for `config`: Current:
  `Show, get, or set .blobsy.yml values` New:
  `Get or set configuration (use --global for user config, --show-origin to see where values come from)`

- [ ] **`README.md`** — Add a brief note in the Backend Configuration section about
  using `blobsy config --show-origin` to debug which config level is active

- [ ] **`packages/blobsy/SKILL.md`** — Update config command reference with new flags

- [ ] **`CHANGELOG.md`** — Add “Added” entries:
  - `blobsy config --global` to read/write user-global config
  - `blobsy config --show-origin` to show where values come from
  - `blobsy config --unset` to remove config keys

- [ ] **`docs/project/design/current/blobsy-design.md`** — Update the `blobsy config`
  command spec to include the new flags

## Testing Strategy

Every new command and feature needs golden tests (tryscript) covering the standard
output modes and edge cases.
The pattern follows existing tests — see `tests/golden/commands/track.tryscript.md` for
a canonical example with setup, behavioral assertions, and filesystem verification.

### Golden test coverage matrix

| Feature | Golden test file | Key scenarios |
| --- | --- | --- |
| **Phase 0: Ignore** | `track.tryscript.md` | `track .` skips `node_modules/`; custom ignore patterns in config |
|  | `externalization.tryscript.md` | Custom `ignore` patterns skip matching files |
|  | `status.tryscript.md` | `status` skips `.bref` files inside ignored directories (if `findBrefFiles` updated) |
| **Phase 1: Empty always** | `externalization.tryscript.md` | Updated output with empty default `always` list |
|  | `track.tryscript.md` | Updated output if affected |
| **Phase 2: --min-size** | `track.tryscript.md` | `track --min-size 50 <dir>` externalizes small files |
|  | `externalization.tryscript.md` | `--min-size` overrides config setting |
|  | `track-json.tryscript.md` | `track --json --min-size` output shape |
| **Phase 3: add** | `add.tryscript.md` (new) | `add .`, `add <file>`, `add <dir1> <dir2>`, mixed, idempotent, `git status` verification, small files staged, `--min-size` + `add`, `--force` + `add` |
|  | `dry-run.tryscript.md` | `--dry-run add` shows intent, nothing staged |
|  | `quiet.tryscript.md` | `--quiet add` suppresses output, files still staged |
|  | `verbose.tryscript.md` | `--verbose add` shows detailed per-file output |
|  | `add-json.tryscript.md` (new) | `add --json`, `--dry-run --json add` |
|  | `help.tryscript.md` | `add` in command list, `add --help` per-command help |
|  | `track.tryscript.md` | Verify `track` unchanged (no staging) |
| **Phase 4: readme** | `readme.tryscript.md` (new) | `readme` full output head, Quick Start present |
|  | `help.tryscript.md` | `readme` in command list, `readme --help` |
| **Phase 4: docs** | `docs.tryscript.md` (new) | `--list`, `--brief`, topic extraction, partial match, error on missing section |
|  | `help.tryscript.md` | `docs` in command list, `docs --help` with topic/flags |
| **Phase 5: colored help** | `help.tryscript.md` | Updated output with `showGlobalOptions: true`; epilog promotes `blobsy readme`/`docs` |
|  | `help-error.tryscript.md` (new) | Unknown command, missing required arg — error + `blobsy docs` hint |
| **Phase 6: hooks** | `hooks.tryscript.md` (update existing) | `hooks install` creates both, `hooks uninstall` removes both |
|  | `init.tryscript.md` (update existing) | Default init installs hooks; `--no-hooks` skips |
|  | `pre-commit-hook.tryscript.md` (new) | Hash mismatch rejected; clean commit passes; `--no-verify` bypasses |
|  | `pre-push-hook.tryscript.md` (new) | Auto-push on git push; already-pushed is silent; `BLOBSY_NO_HOOKS=1` bypasses |
| **Phase 7: config** | `config.tryscript.md` (update existing) | `config` shows resolved effective; `--global` read/write; `--show-origin`; `--unset` + `cat` verification |
|  | `config-json.tryscript.md` (update existing) | `--show-origin --json`; `--global --json`; `--unset --json` |
|  | `config-global.tryscript.md` (new) | Multi-level precedence: builtin → global → repo, set/unset at each level, verify with `cat` and `--show-origin` |
|  | `config-show-origin.tryscript.md` (new) | `--show-origin` with no key lists all effective values with scopes |
|  | `config-global-no-repo.tryscript.md` (new) | `--global` read/write from outside a git repo; error without `--global` |
|  | `help.tryscript.md` (update existing) | `config --help` shows `--global`, `--show-origin`, `--unset` options |

### Unit test coverage

| Feature | Test file | Key scenarios |
| --- | --- | --- |
| **Phase 0** | `paths.test.ts` | `findTrackableFiles()` with/without ignore patterns, no recursion into ignored dirs |
| **Phase 1** | `config.test.ts` | Verify `getBuiltinDefaults().externalize.always` is empty array |
| **Phase 2** | `externalize.test.ts` | `shouldExternalize()` with overridden `min_size` |
| **Phase 4** | `markdown-output.test.ts` (new) | `extractSections()`, `findSection()`, `renderMarkdown()` non-interactive, `isInteractive()` |
| **Phase 6** | `hooks.test.ts` | Both hooks installed/uninstalled; `--no-hooks` skips; `BLOBSY_NO_HOOKS` env var |
| **Phase 7** | `config.test.ts` (new) | `resolveConfigWithOrigins()` returns correct scopes; `unsetNestedValue()` removes keys; `getTargetConfigPath()` with/without `--global` |

## Open Questions

None — all changes are straightforward and self-contained.

## References

- [blobsy-design.md](../../design/current/blobsy-design.md) — Externalization Rule
  Precedence section
- [README.md](../../../../README.md) — Externalization Rules section

**tbd reference code** (copy and adapt as needed):

- `attic/tbd/packages/tbd/src/utils/gitignore-utils.ts` — `hasGitignorePattern()`,
  `ensureGitignorePatterns()` for idempotent `.gitignore` management with atomic writes
  and trailing-slash normalization.
  Tests: `attic/tbd/packages/tbd/tests/gitignore-utils.test.ts`
- `attic/tbd/packages/tbd/src/file/git.ts` — `git()` wrapper using `execFile` (safe
  against shell injection), `withIsolatedIndex()` for staging operations that don’t
  disturb the user’s index
- `attic/tbd/packages/tbd/src/cli/commands/docs.ts` — `blobsy docs` command pattern
  (section extraction, `--list`, topic argument)
- `attic/tbd/packages/tbd/src/cli/commands/readme.ts` — `blobsy readme` command pattern
  (bundled doc loading with dev fallback)
- `attic/tbd/packages/tbd/src/cli/lib/output.ts` — markdown terminal rendering via
  `marked` + `marked-terminal`, pagination through `less -R`, and
  `createColoredHelpConfig()` at lines 106-116 for Commander v14 styled help
- `attic/tbd/packages/tbd/src/cli/cli.ts` — `configureColoredHelp()` application,
  `commandsGroup()` for organized help sections, `showHelpAfterError()`,
  `applyColoredHelpToAllCommands()` recursive helper
