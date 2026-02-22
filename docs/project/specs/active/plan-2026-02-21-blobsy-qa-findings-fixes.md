---
title: Blobsy QA Findings and Required Fixes
description: Critical fixes and missing features discovered during comprehensive QA testing
author: Claude Code Agent (based on QA testing results)
---
# Feature: QA Findings - Critical Fixes and Missing Features

**Date:** 2026-02-21 (last updated 2026-02-21)

**Author:** Claude Code Agent

**Status:** Draft

## Overview

During comprehensive end-to-end QA testing of Blobsy v0.1.0, we discovered several
critical issues and missing features that must be addressed before the v1.0 release.
While the core functionality works well, these gaps prevent the tool from meeting its
design specifications and create poor user experience in key workflows.

This spec documents all issues found during QA testing and provides an implementation
plan to address them.
**These are not optional improvements - they are required to match the original
design.**

## Goals

- Fix all critical UX issues discovered during QA testing
- Implement missing features required by the design specification
- Ensure error messages are user-friendly and actionable
- Complete all promised functionality for Git hooks
- Auto-create backend directories as expected by users
- Provide complete deletion options (local + remote)

## Non-Goals

- Performance optimizations (core performance is acceptable)
- Additional compression algorithms beyond zstd/gzip/brotli
- New features not in original design
- Multi-backend or backend migration features

## Background

### QA Testing Results

Comprehensive QA testing (7 phases, all backends, all compression algorithms) revealed:

**✅ What Works Well:**
- Core workflow (track → push → pull → verify) is solid
- All compression algorithms work correctly
- S3 backend integration fully functional
- Hash verification and integrity checks perfect
- Advanced operations (mv, rm, sync) functional but incomplete

**❌ Critical Issues Found:**

1. **Local Backend Directory Not Auto-Created** (Issue #1)
   - Users must manually `mkdir` backend directory before init
   - Error message is technical: “Local backend directory not found”
   - Original design: init should create directories automatically

2. **Git Hooks Fail Silently** (Issue #2)
   - Hooks install correctly but fail at runtime if blobsy not in PATH
   - Error: `.git/hooks/pre-commit: line 4: exec: blobsy: not found`
   - No graceful fallback or helpful error message
   - Original design: hooks should work reliably or provide clear instructions

3. **Error Messages Too Technical** (Issue #3)
   - “ENOENT: no such file or directory, open '/path/to/file.yref'”
   - Should be: “File not tracked.
     Run: blobsy track <file>”
   - Multiple instances throughout codebase

4. **No Remote Blob Deletion** (Issue #4)
   - `blobsy rm` removes local+.yref but always keeps remote blob
   - No `--remote` flag to delete from backend
   - Original design: should support full cleanup when desired

5. **Backend Switching Undocumented** (Issue #5)
   - Changing backend URL doesn’t re-push files (keeps old remote_key)
   - Correct behavior but confusing without documentation
   - Need user guide section explaining this

6. **Missing rm --local .yref Behavior** (Issue #6)
   - `blobsy rm --local` removes only local file
   - Should it keep or remove .yref?
     Current: keeps .yref
   - Need to verify this matches design intent

## Design

### Issue #1: Auto-Create Backend Directories

**Problem:**
```bash
$ blobsy init local:../blobsy-remote
# Fails with: "Local backend directory not found: /path/to/blobsy-remote"
# User must: mkdir -p ../blobsy-remote && blobsy init local:../blobsy-remote
```

**Solution:**
- For `local://` backend URLs, auto-create directory structure
- Check write permissions on parent directory first
- Provide clear error if parent doesn’t exist or lacks permissions
- Example: `mkdir -p /resolved/path/to/backend`

**Files to modify:**
- `packages/blobsy/src/backend-url.ts` - Remove directory existence check from
  validation
- `packages/blobsy/src/cli.ts` - Add directory creation to init command

**User-friendly error:**
```
✗ Cannot create backend directory: /path/to/blobsy-remote
  Parent directory does not exist: /path/to
  Create parent first: mkdir -p /path/to
```

### Detailed Implementation for Fix #1

#### Step 1: Modify `backend-url.ts` validation

**File:** `packages/blobsy/src/backend-url.ts`

**Find** the `validateBackendUrl()` function (search for
`export function validateBackendUrl`).

**Current code** (approximate):
```typescript
export function validateBackendUrl(parsed: ParsedBackendUrl, repoRoot: string): void {
  if (parsed.type === 'local') {
    const absPath = path.resolve(repoRoot, parsed.path);
    if (!existsSync(absPath)) {
      throw new ValidationError(`Local backend directory not found: ${absPath}`);
    }
    // Check if inside repo...
  }
  // ... other validations ...
}
```

**Change to:**
```typescript
export function validateBackendUrl(parsed: ParsedBackendUrl, repoRoot: string): void {
  if (parsed.type === 'local') {
    const absPath = path.resolve(repoRoot, parsed.path);

    // REMOVED: Directory existence check (will be created by init)

    // Still check that path is outside repo
    const normalizedRepo = path.resolve(repoRoot);
    const normalizedBackend = path.resolve(absPath);
    if (normalizedBackend.startsWith(normalizedRepo + path.sep) || normalizedBackend === normalizedRepo) {
      throw new ValidationError(
        `Backend path must be outside repository root.\n  Backend: ${absPath}\n  Repo: ${repoRoot}`
      );
    }
  }
  // ... other validations ...
}
```

#### Step 2: Add directory creation to `handleInit()`

**File:** `packages/blobsy/src/cli.ts` **Function:** `handleInit()` (starts at line 345)

**After line 351** (`validateBackendUrl(parsed, repoRoot);`), add:

```typescript
  validateBackendUrl(parsed, repoRoot);

  // Auto-create local backend directory if it doesn't exist
  if (parsed.type === 'local') {
    const absPath = path.resolve(repoRoot, parsed.path);

    if (!existsSync(absPath)) {
      // Check parent directory exists and is writable
      const parentDir = path.dirname(absPath);

      if (!existsSync(parentDir)) {
        throw new ValidationError(
          `Cannot create backend directory: ${absPath}\n` +
          `  Parent directory does not exist: ${parentDir}\n` +
          `  Create parent first: mkdir -p ${parentDir}`
        );
      }

      try {
        // Test write permissions
        const { access, mkdir } = await import('node:fs/promises');
        await access(parentDir, constants.W_OK);

        // Create backend directory
        await mkdir(absPath, { recursive: true });

        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(`Created backend directory: ${normalizePath(toRepoRelative(absPath, repoRoot))}`);
        }
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'EACCES') {
          throw new ValidationError(
            `Permission denied creating backend directory: ${absPath}\n` +
            `  Parent directory not writable: ${parentDir}`
          );
        }
        throw error; // Re-throw unexpected errors
      }
    }
  }

  if (globalOpts.dryRun) {
    // ... existing dry-run code ...
```

**Required imports** (add at top of file if not already present):
```typescript
import { constants } from 'node:fs';
import * as path from 'node:path';
```

#### Test Cases for Fix #1

**File:** `packages/blobsy/tests/commands/init.test.ts` (create if doesn’t exist)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('init command - auto-create directories', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `blobsy-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    // Create git repo
    await execa('git', ['init'], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should auto-create local backend directory', async () => {
    const backendPath = join(testDir, '..', 'blobsy-remote');

    // Directory should not exist yet
    expect(existsSync(backendPath)).toBe(false);

    // Init should create it
    await execa('blobsy', ['init', `local:../blobsy-remote`], { cwd: testDir });

    // Directory should now exist
    expect(existsSync(backendPath)).toBe(true);
  });

  it('should error if parent directory does not exist', async () => {
    await expect(
      execa('blobsy', ['init', `local:../../nonexistent/blobsy-remote`], { cwd: testDir })
    ).rejects.toThrow(/Parent directory does not exist/);
  });

  it('should error if parent directory not writable', async () => {
    const readonlyParent = join(testDir, 'readonly');
    await mkdir(readonlyParent);
    await chmod(readonlyParent, 0o444); // Read-only

    await expect(
      execa('blobsy', ['init', `local:readonly/backend`], { cwd: testDir })
    ).rejects.toThrow(/Permission denied/);

    await chmod(readonlyParent, 0o755); // Restore for cleanup
  });
});
```

### Issue #2: Git Hooks Reliability

**Problem:**
```bash
$ blobsy hooks install
# Creates .git/hooks/pre-commit with: exec blobsy hook pre-commit
# But fails at runtime if 'blobsy' not in PATH
.git/hooks/pre-commit: line 4: exec: blobsy: not found
```

**Solution Option A (Recommended):** Store absolute path in hook
```bash
#!/bin/sh
# Installed by: blobsy hooks install
# To bypass: git commit --no-verify
exec /absolute/path/to/blobsy hook pre-commit
```

**Solution Option B:** Graceful degradation
```bash
#!/bin/sh
if ! command -v blobsy >/dev/null 2>&1; then
  echo "⚠️  blobsy not in PATH - pre-commit check skipped"
  echo "   To enable: ensure blobsy is installed globally"
  exit 0
fi
exec blobsy hook pre-commit
```

**Recommendation:** Use Option A (absolute path) as primary, with clear error message
during install if blobsy binary can’t be located.

**Files to modify:**
- `packages/blobsy/src/commands-stage2.ts` - Update hook installation logic in
  `handleHooks()`
- Detect current blobsy executable path (process.argv[1] or which blobsy)
- Write absolute path to hook

**Alternative consideration:** Embed hook logic directly in .git/hooks/pre-commit to
avoid PATH issues entirely (inline the check instead of exec).

### Detailed Implementation for Fix #2

**File:** `packages/blobsy/src/commands-stage2.ts` **Function:** `handleHooks()` (starts
at line 561)

**Replace lines 579-588** with:

```typescript
if (action === 'install') {
  const hookDir = join(repoRoot, '.git', 'hooks');
  await ensureDir(hookDir);
  const { writeFile: writeFs, chmod } = await import('node:fs/promises');

  // Detect absolute path to blobsy executable
  let blobsyPath: string;

  // Option 1: Use process.argv[1] (current executable)
  const execPath = process.argv[1];

  if (execPath && path.isAbsolute(execPath)) {
    blobsyPath = execPath;
  } else {
    // Option 2: Try to find blobsy in PATH
    try {
      const { execa } = await import('execa');
      const result = await execa('which', ['blobsy']);
      blobsyPath = result.stdout.trim();
    } catch {
      // Fallback: use 'blobsy' and warn user
      blobsyPath = 'blobsy';

      if (!globalOpts.quiet) {
        console.warn(
          '⚠️  Warning: Could not detect absolute path to blobsy executable.\n' +
          '   Hook will use "blobsy" from PATH.\n' +
          '   To ensure hooks work, install blobsy globally: pnpm link --global'
        );
      }
    }
  }

  const hookContent = `#!/bin/sh
# Installed by: blobsy hooks install
# To bypass: git commit --no-verify
exec "${blobsyPath}" hook pre-commit
`;

  await writeFs(hookPath, hookContent);
  await chmod(hookPath, 0o755);

  if (!globalOpts.quiet) {
    console.log('Installed pre-commit hook.');
    if (blobsyPath !== 'blobsy') {
      console.log(`  Using executable: ${blobsyPath}`);
    }
  }
}
```

**Required imports** (add at top of file if not already present):
```typescript
import * as path from 'node:path';
```

#### Test Cases for Fix #2

**File:** `packages/blobsy/tests/commands/hooks.test.ts`

```typescript
describe('hooks command - absolute path', () => {
  it('should write absolute path to hook file', async () => {
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    const hookPath = join(testDir, '.git', 'hooks', 'pre-commit');
    const hookContent = await readFile(hookPath, 'utf-8');

    // Should contain absolute path, not just "blobsy"
    expect(hookContent).toMatch(/exec "\/.*\/blobsy" hook pre-commit/);
    expect(hookContent).not.toMatch(/exec blobsy hook pre-commit/);
  });

  it('should execute successfully even if blobsy not in PATH', async () => {
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    // Remove blobsy from PATH
    const { stdout } = await execa('git', ['commit', '-m', 'test'], {
      cwd: testDir,
      env: { ...process.env, PATH: '/usr/bin:/bin' }, // Minimal PATH
      reject: false,
    });

    // Hook should still execute (though may fail for other reasons)
    // At minimum, should not fail with "blobsy: not found"
    expect(stdout).not.toMatch(/blobsy: not found/);
  });
});
```

### Issue #3: User-Friendly Error Messages

**Problem:** Technical errors exposed to users:
```
✗ Error: Cannot read .yref file: /path/to/file.yref: ENOENT: no such file or directory
```

**Solution:** Wrap all file I/O errors with user-friendly context:

```typescript
// BAD:
const content = await fs.readFile(yrefPath, 'utf-8');

// GOOD:
try {
  const content = await fs.readFile(yrefPath, 'utf-8');
} catch (err) {
  if (err.code === 'ENOENT') {
    throw new UserError(
      `File not tracked: ${path.basename(yrefPath, '.yref')}`,
      `Run: blobsy track ${path.basename(yrefPath, '.yref')}`
    );
  }
  throw err; // Unexpected errors still bubble up
}
```

**Error message patterns to implement:**

| Technical Error | User-Friendly Error |
| --- | --- |
| ENOENT on .yref read | File not tracked: <file><br>Run: blobsy track <file> |
| ENOENT on blob read | Blob not found in backend<br>File may not be pushed yet<br>Run: blobsy push <file> |
| EACCES | Permission denied: <path><br>Check file/directory permissions |
| EISDIR | Expected file, got directory: <path> |
| Backend 404 | Blob not found in backend<br>May need to re-push: blobsy push --force |

**Files to modify:**
- `packages/blobsy/src/types.ts` (or create `packages/blobsy/src/errors.ts`) - Add
  UserError class with hint support
- `packages/blobsy/src/ref.ts` - Wrap file operations
- `packages/blobsy/src/backend-local.ts` and `backend-s3.ts` - Wrap backend operations
- `packages/blobsy/src/cli.ts` - Update error handler in `wrapAction()`

**Error class design:**
```typescript
export class UserError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public exitCode: number = 1
  ) {
    super(message);
    this.name = 'UserError';
  }
}

// CLI formatting:
function formatError(err: Error): string {
  if (err instanceof UserError) {
    let output = `✗ ${err.message}`;
    if (err.hint) {
      output += `\n  ${err.hint}`;
    }
    return output;
  }
  return `✗ Error: ${err.message}`; // Technical errors
}
```

### Detailed Implementation for Fix #3

#### Step 1: Create UserError Class

**File:** `packages/blobsy/src/types.ts` (or create `packages/blobsy/src/errors.ts`)

**Add new error class:**

```typescript
/**
 * User-friendly error with optional hint for resolution.
 * Use this for expected errors (file not found, not tracked, etc.)
 * Let unexpected errors (bugs) bubble up as-is.
 */
export class UserError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public exitCode: number = 1
  ) {
    super(message);
    this.name = 'UserError';

    // Maintain proper stack trace for debugging
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UserError);
    }
  }

  /**
   * Format for CLI output
   */
  format(): string {
    let output = `✗ ${this.message}`;
    if (this.hint) {
      output += `\n  ${this.hint}`;
    }
    return output;
  }
}
```

#### Step 2: Wrap File Operations in ref.ts

**File:** `packages/blobsy/src/ref.ts` **Function:** `readYRef()`

**Current code** (approximate):
```typescript
export async function readYRef(refPath: string): Promise<YRef> {
  const content = await readFile(refPath, 'utf-8');  // ← Can throw ENOENT
  // ... parse YAML ...
}
```

**Change to:**
```typescript
export async function readYRef(refPath: string): Promise<YRef> {
  let content: string;

  try {
    content = await readFile(refPath, 'utf-8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      const fileName = path.basename(refPath, '.yref');
      throw new UserError(
        `File not tracked: ${fileName}`,
        `Run: blobsy track ${fileName}`
      );
    }

    if (error.code === 'EACCES') {
      throw new UserError(
        `Permission denied reading .yref file: ${refPath}`,
        `Check file permissions: chmod +r ${refPath}`
      );
    }

    // Unexpected error - let it bubble up
    throw error;
  }

  // ... continue with parsing ...

  try {
    const parsed = yaml.load(content);
    // ... validation ...
  } catch (yamlErr) {
    throw new UserError(
      `Failed to parse .yref file: ${path.basename(refPath)}`,
      `File may be corrupted. Check YAML syntax or regenerate with: blobsy track --force ${path.basename(refPath, '.yref')}`
    );
  }

  return parsed as YRef;
}
```

#### Step 3: Create Error Message Catalog

**File:** `packages/blobsy/src/error-messages.ts` (new file)

```typescript
import { UserError } from './types.js';
import { basename } from 'node:path';

/**
 * Standard error messages with hints.
 * Centralized to ensure consistency across all commands.
 */

export function fileNotTrackedError(filePath: string): UserError {
  const fileName = basename(filePath, '.yref');
  return new UserError(
    `File not tracked: ${fileName}`,
    `Run: blobsy track ${fileName}`
  );
}

export function blobNotFoundError(filePath: string): UserError {
  const fileName = basename(filePath);
  return new UserError(
    `Blob not found in backend: ${fileName}`,
    `File may not be pushed yet. Run: blobsy push ${fileName}`
  );
}

export function permissionDeniedError(path: string, operation: string): UserError {
  return new UserError(
    `Permission denied ${operation}: ${path}`,
    `Check file/directory permissions`
  );
}

export function directoryExpectedError(path: string): UserError {
  return new UserError(
    `Expected directory, got file: ${path}`,
    `Use directory path or --recursive flag`
  );
}

export function fileExpectedError(path: string): UserError {
  return new UserError(
    `Expected file, got directory: ${path}`,
    `Use --recursive flag to process directories`
  );
}

export function backendNotFoundError(backendUrl: string): UserError {
  return new UserError(
    `Cannot access backend: ${backendUrl}`,
    `Check backend configuration and connectivity`
  );
}

export function invalidYrefFormatError(filePath: string): UserError {
  const fileName = basename(filePath);
  return new UserError(
    `Invalid .yref file format: ${fileName}`,
    `File may be corrupted. Regenerate with: blobsy track --force ${basename(fileName, '.yref')}`
  );
}
```

#### Step 4: Update CLI Error Handler

**File:** `packages/blobsy/src/cli.ts` **Function:** `wrapAction()` (search for existing
error handler)

**Find the error handling code** (likely in a wrapper function):

```typescript
function wrapAction(fn: (...args: unknown[]) => Promise<void>) {
  return async (...args: unknown[]) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      // ADD THIS:
      if (err instanceof UserError) {
        console.error(err.format());
        process.exit(err.exitCode);
      }

      // Existing error handling:
      if (err instanceof ValidationError || err instanceof BlobsyError) {
        console.error(formatError(err.message));
        process.exit(1);
      }

      // Unexpected errors
      console.error('Unexpected error:', err);
      process.exit(1);
    }
  };
}
```

#### Step 5: Wrap Backend Operations

**File:** `packages/blobsy/src/backend-local.ts`

**Example for read() method:**

```typescript
async read(key: string): Promise<Buffer> {
  const filePath = this.keyToPath(key);

  try {
    return await readFile(filePath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      throw new UserError(
        `Blob not found in backend: ${key}`,
        `Backend may be incomplete. Try: blobsy push --force`
      );
    }

    if (error.code === 'EACCES') {
      throw new UserError(
        `Permission denied reading from backend: ${filePath}`,
        `Check backend directory permissions`
      );
    }

    throw error; // Unexpected
  }
}
```

**Locations to Apply Error Wrapping:**
- `packages/blobsy/src/ref.ts` - readYRef() ← DONE above
- `packages/blobsy/src/config.ts` - readConfigFile()
- `packages/blobsy/src/cli.ts` - All file operations in commands
- `packages/blobsy/src/backend-local.ts` - read(), write(), delete()
- `packages/blobsy/src/backend-s3.ts` - read(), write(), delete()
- `packages/blobsy/src/backend-command.ts` - executeBackendCommand()

#### Test Cases for Fix #3

**File:** `packages/blobsy/tests/errors/user-error.test.ts`

```typescript
describe('UserError formatting', () => {
  it('should format error with hint', () => {
    const err = new UserError('File not found', 'Run: blobsy track file.bin');
    expect(err.format()).toBe('✗ File not found\n  Run: blobsy track file.bin');
  });

  it('should format error without hint', () => {
    const err = new UserError('Operation failed');
    expect(err.format()).toBe('✗ Operation failed');
  });
});

describe('File operations error messages', () => {
  it('should show user-friendly error for untracked file', async () => {
    await expect(
      execa('blobsy', ['push', 'untracked.bin'], { cwd: testDir })
    ).rejects.toThrow(/File not tracked: untracked.bin/);

    // Should NOT show:
    await expect(
      execa('blobsy', ['push', 'untracked.bin'], { cwd: testDir })
    ).rejects.not.toThrow(/ENOENT/);
  });

  it('should suggest blobsy track in error hint', async () => {
    const { stderr } = await execa('blobsy', ['push', 'untracked.bin'], {
      cwd: testDir,
      reject: false
    });

    expect(stderr).toMatch(/Run: blobsy track untracked.bin/);
  });
});
```

### Issue #4: Remote Blob Deletion Support

**Problem:**
```bash
$ blobsy rm large-file.bin
# Removes local file + .yref, but remote blob remains in backend
# No way to delete remote blob
```

**Solution:** Add `--remote` flag to `blobsy rm`:

```bash
# Current behavior (safe deletion):
$ blobsy rm file.bin
# → Removes local file + .yref, keeps remote blob

# New behavior:
$ blobsy rm file.bin --remote
# → Removes local file + .yref + remote blob
# → Prompts for confirmation: "Delete remote blob? This cannot be undone. (y/N)"

# Force mode (no confirmation):
$ blobsy rm file.bin --remote --force
```

**Files to modify:**
- `packages/blobsy/src/cli.ts` - Add --remote flag to rm command, update handleRm()
- Add confirmation prompt unless --force
- Call backend.delete(remoteKey) if confirmed
- Update help text and examples

**Safety considerations:**
- Default behavior unchanged (keeps remote blob)
- Confirmation required unless --force
- Clear warning: “This cannot be undone”
- Show remote key being deleted

### Detailed Implementation for Fix #4

#### Step 1: Update command definition

**File:** `packages/blobsy/src/cli.ts` **Line 179-184:** Update command definition

**Change from:**
```typescript
  .command('rm')
  .description('Remove tracked files: delete local + move .yref to trash')
  .argument('<path...>', 'Files or directories to remove')
  .option('--local', 'Delete local file only, keep .yref and remote')
  .option('--recursive', 'Required for directory removal')
  .action(wrapAction(handleRm));
```

**Change to:**
```typescript
  .command('rm')
  .description('Remove tracked files: delete local + move .yref to trash')
  .argument('<path...>', 'Files or directories to remove')
  .option('--local', 'Delete local file only, keep .yref and remote')
  .option('--remote', 'Also delete blob from backend (requires confirmation)')
  .option('--force', 'Skip confirmation prompts')
  .option('--recursive', 'Required for directory removal')
  .action(wrapAction(handleRm));
```

#### Step 2: Update handleRm() function signature

**File:** `packages/blobsy/src/cli.ts` **Line 892:** Update function signature

**Change from:**
```typescript
async function handleRm(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const localOnly = Boolean(opts.local);
  const recursive = Boolean(opts.recursive);
```

**Change to:**
```typescript
async function handleRm(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const localOnly = Boolean(opts.local);
  const deleteRemote = Boolean(opts.remote);
  const force = Boolean(opts.force) || globalOpts.force;
  const recursive = Boolean(opts.recursive);

  // Validate flag combinations
  if (localOnly && deleteRemote) {
    throw new ValidationError('Cannot use both --local and --remote flags');
  }
```

#### Step 3: Update rmFile() calls

**Line 913 and 916:** Update rmFile call signatures

**Change from:**
```typescript
      await rmFile(join(repoRoot, rel), repoRoot, localOnly, globalOpts);
```

**Change to:**
```typescript
      await rmFile(join(repoRoot, rel), repoRoot, localOnly, deleteRemote, force, globalOpts);
```

#### Step 4: Update rmFile() function

**Line 921-978:** Update rmFile function

**Change function signature from:**
```typescript
async function rmFile(
  absPath: string,
  repoRoot: string,
  localOnly: boolean,
  globalOpts: GlobalOptions,
): Promise<void> {
```

**Change to:**
```typescript
async function rmFile(
  absPath: string,
  repoRoot: string,
  localOnly: boolean,
  deleteRemote: boolean,
  force: boolean,
  globalOpts: GlobalOptions,
): Promise<void> {
```

**After line 965** (after moving .yref to trash), **add remote deletion logic:**

```typescript
  // Move .yref to trash
  const trashDir = join(repoRoot, '.blobsy', 'trash');
  await ensureDir(trashDir);
  const trashPath = join(trashDir, `${basename(refPath)}.${Date.now()}`);
  await rename(refPath, trashPath);

  // Delete from backend if --remote flag set
  if (deleteRemote) {
    const yref = await readYRef(trashPath); // Read from trash copy

    if (yref.remote_key) {
      // Confirmation prompt (unless --force)
      if (!force && !globalOpts.quiet) {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const answer = await rl.question(
          `Delete blob from backend?\n` +
          `  File: ${relPath}\n` +
          `  Remote key: ${yref.remote_key}\n` +
          `  This cannot be undone. Continue? (y/N): `
        );

        rl.close();

        if (answer.toLowerCase() !== 'y') {
          if (!globalOpts.quiet) {
            console.log('Remote deletion cancelled. Local file and .yref removed, remote blob kept.');
          }
          return;
        }
      }

      // Delete from backend
      try {
        const config = await resolveConfig(repoRoot);
        const backend = await createBackend(config.backends.default, repoRoot);
        await backend.delete(yref.remote_key);

        if (!globalOpts.quiet) {
          if (globalOpts.json) {
            console.log(formatJsonMessage(`Deleted from backend: ${yref.remote_key}`));
          } else {
            console.log(`Deleted from backend: ${yref.remote_key}`);
          }
        }
      } catch (err: unknown) {
        // Don't fail the whole rm operation if backend deletion fails
        // Local cleanup already succeeded
        console.warn(`Warning: Failed to delete from backend: ${(err as Error).message}`);
        console.warn(`  Remote blob may still exist: ${yref.remote_key}`);
      }
    } else {
      if (!globalOpts.quiet) {
        console.log(`Note: File was never pushed (no remote_key), skipping backend deletion`);
      }
    }
  }

  // Remove from gitignore
  await removeGitignoreEntry(fileDir, fileName);
```

**Required imports** (add at top of cli.ts):
```typescript
import { createBackend } from './backend-command.js'; // May need to export this from backend-command.ts
```

#### Test Cases for Fix #4

**File:** `packages/blobsy/tests/commands/rm.test.ts`

```typescript
describe('rm command - remote deletion', () => {
  it('should delete remote blob with --remote flag', async () => {
    // Setup: track, push, then rm --remote
    await writeFile(join(testDir, 'file.bin'), 'test content');
    await execa('blobsy', ['track', 'file.bin'], { cwd: testDir });
    await execa('blobsy', ['push'], { cwd: testDir });

    // Get remote key before deletion
    const yrefPath = join(testDir, 'file.bin.yref');
    const yref = await readYRef(yrefPath);
    const remoteKey = yref.remote_key!;

    // Check blob exists in backend
    const backendPath = join(testDir, '..', 'backend', remoteKey);
    expect(existsSync(backendPath)).toBe(true);

    // Delete with --remote --force (skip confirmation)
    await execa('blobsy', ['rm', 'file.bin', '--remote', '--force'], { cwd: testDir });

    // Blob should be deleted from backend
    expect(existsSync(backendPath)).toBe(false);
  });

  it('should prompt for confirmation without --force', async () => {
    await writeFile(join(testDir, 'file.bin'), 'test content');
    await execa('blobsy', ['track', 'file.bin'], { cwd: testDir });
    await execa('blobsy', ['push'], { cwd: testDir });

    // Mock stdin to answer 'n'
    const child = spawn('blobsy', ['rm', 'file.bin', '--remote'], {
      cwd: testDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write('n\n');
    child.stdin.end();

    await new Promise(resolve => child.on('close', resolve));

    // Blob should still exist (deletion cancelled)
    const yref = await readYRef(join(testDir, 'file.bin.yref.trash'));
    const backendPath = join(testDir, '..', 'backend', yref.remote_key!);
    expect(existsSync(backendPath)).toBe(true);
  });

  it('should error when using both --local and --remote', async () => {
    await expect(
      execa('blobsy', ['rm', 'file.bin', '--local', '--remote'], { cwd: testDir })
    ).rejects.toThrow(/Cannot use both --local and --remote/);
  });

  it('should handle unpushed files gracefully with --remote', async () => {
    await writeFile(join(testDir, 'file.bin'), 'test content');
    await execa('blobsy', ['track', 'file.bin'], { cwd: testDir });
    // DON'T push

    // Should complete without error (just note that file wasn't pushed)
    const { stdout } = await execa('blobsy', ['rm', 'file.bin', '--remote', '--force'], {
      cwd: testDir
    });

    expect(stdout).toMatch(/File was never pushed.*skipping backend deletion/);
  });
});
```

### Issue #5: Backend Switching Documentation

**Problem:** Users expect files to re-push when changing backend URL, but they don’t
(remote_key stays the same).

**Solution:** Not a code fix - documentation only:

**Files to modify:**
- `packages/blobsy/README.md` - Add “Changing Backends” section
- `docs/project/design/current/blobsy-backend-and-transport-design.md` - Document
  behavior

**Documentation to add:**

````markdown
## Changing Backends

If you change the backend URL in `.blobsy.yml`, existing tracked files will **NOT** automatically re-push to the new backend. Each file's `.yref` contains a `remote_key` that points to the original backend location.

To migrate files to a new backend:

1. Change backend URL in `.blobsy.yml`
2. Re-track and force-push files:
   ```bash
   blobsy track --force <file>
   blobsy push --force <file>
````

Or migrate all files:
```bash
blobsy track --force .
blobsy push --force
```

**Why this behavior?** Preserving remote_key prevents accidental data duplication when
switching between backends for testing.
````

### Issue #6: Verify rm --local Behavior

**Current behavior:**
```bash
$ blobsy rm file.bin --local
# Removes: local file
# Keeps: .yref, remote blob
````

**Question:** Is this the intended design?

**Use case analysis:**
- **Keep .yref**: Allows later re-pull with `blobsy pull file.bin`
- **Remove .yref**: Fully untrack locally, but preserve remote

**Recommendation:** Current behavior (keep .yref) is correct - allows re-pull.

**Required action:** Document this clearly in help text and README.

**Files to modify:**
- `packages/blobsy/src/commands/rm.ts` - Update help text
- `packages/blobsy/README.md` - Document --local flag behavior

## Implementation Plan

### Phase 1: Critical UX Fixes

**Priority:** P0 (must fix before v1.0)

- [ ] **Fix #1: Auto-create local backend directories**
  - Modify `init.ts` to create directories for local:// URLs
  - Add parent directory existence check
  - Add user-friendly error for permission issues
  - Add test: init with non-existent local path
  - Add test: init with unwritable parent directory

- [ ] **Fix #2: Git hooks reliability**
  - Modify `hooks.ts` to use absolute path to blobsy binary
  - Detect executable path during `hooks install`
  - Add error if binary can’t be located
  - Update hook template with absolute path
  - Add test: hooks install with blobsy not in PATH
  - Document hook installation requirements

- [ ] **Fix #3: User-friendly error messages**
  - Create `UserError` class in `core/errors.ts`
  - Wrap all ENOENT errors for .yref files
  - Wrap all ENOENT errors for blob reads
  - Wrap all EACCES permission errors
  - Wrap backend 404 errors
  - Update CLI error formatter
  - Add tests for each error scenario
  - Verify all error messages follow pattern: problem + suggestion

### Phase 2: Feature Completeness

**Priority:** P1 (required for v1.0)

- [ ] **Fix #4: Add --remote flag to rm command**
  - Add --remote flag to rm command
  - Implement confirmation prompt
  - Add --force to skip confirmation
  - Call backend.delete() when --remote specified
  - Show remote key being deleted
  - Add tests: rm with --remote
  - Add tests: rm with --remote --force
  - Add tests: confirmation prompt behavior
  - Update help text with examples

- [ ] **Fix #5: Document backend switching**
  - Add “Changing Backends” section to README
  - Document remote_key preservation behavior
  - Add migration instructions
  - Update backend design doc

- [ ] **Fix #6: Document rm --local behavior**
  - Update rm command help text
  - Clarify what --local keeps vs removes
  - Add examples to README
  - Add to troubleshooting guide

### Phase 3: Validation & Polish

**Priority:** P2 (before release)

- [ ] **Update QA playbook**
  - Remove “Optional improvements” section
  - Update expected behaviors for all fixes
  - Add tests for new error messages
  - Verify all 7 phases still pass

- [ ] **Update all error message tests**
  - Ensure golden tests capture new error formats
  - Update snapshots for UserError output
  - Add test coverage for all UserError paths

- [ ] **Documentation review**
  - README has all new flags documented
  - Design docs reflect actual behavior
  - No contradictions between docs and implementation

## Testing Strategy

### Unit Tests

**For each fix:**
- Auto-create directories: Test success, parent missing, permission denied
- Git hooks: Test absolute path detection, PATH not set, binary not found
- Error messages: Test each UserError scenario (ENOENT, EACCES, etc.)
- rm --remote: Test deletion, confirmation, --force, backend errors

### Golden Tests

- Update golden test snapshots for new error message formats
- Add golden tests for rm --remote output
- Verify UserError formatting matches expected output

### QA Playbook

- Re-run full end-to-end QA playbook
- Verify Phase 1.3 no longer requires manual mkdir
- Verify Phase 5.4 hooks work with absolute path
- Verify Phase 5.2 rm --remote deletes from backend
- Verify all error messages user-friendly

## Acceptance Criteria

### Issue #1: Backend Directory Auto-Creation

- [ ] `blobsy init local:../new-dir` creates directory automatically
- [ ] Clear error if parent directory doesn’t exist
- [ ] Clear error if permission denied
- [ ] No manual mkdir required in QA playbook

### Issue #2: Git Hooks Reliability

- [ ] `blobsy hooks install` writes absolute path to hook
- [ ] Pre-commit hook executes successfully
- [ ] Clear error if blobsy binary can’t be located during install
- [ ] No PATH-related failures in QA testing

### Issue #3: User-Friendly Errors

- [ ] All ENOENT errors show user-friendly message + suggestion
- [ ] No technical stack traces exposed to users
- [ ] All error messages follow pattern: problem + how to fix
- [ ] Exit codes correct: 0=success, 1=error, 2=conflict

### Issue #4: Remote Deletion

- [ ] `blobsy rm --remote` prompts for confirmation
- [ ] `blobsy rm --remote --force` deletes without prompt
- [ ] Remote blob deleted from backend
- [ ] Clear message showing what was deleted
- [ ] Help text documents --remote flag

### Issue #5: Backend Switching Documentation

- [ ] README has “Changing Backends” section
- [ ] Migration instructions provided
- [ ] Behavior clearly explained
- [ ] Design doc updated

### Issue #6: rm --local Documentation

- [ ] Help text explains what --local keeps/removes
- [ ] README has examples
- [ ] Behavior matches user expectations

## Open Questions

1. **Issue #2 Alternative:** Should we embed hook logic inline instead of exec?
   - Pro: No PATH issues at all
   - Con: Hook code duplicated, harder to update
   - **Decision needed:** Absolute path vs inline logic

2. **Issue #4 Confirmation UX:** What should confirmation prompt look like?
   - Option A: Simple y/N prompt
   - Option B: Require typing remote key to confirm
   - **Recommendation:** Option A (simple y/N) with --force for automation

3. **Error message verbosity:** Should --verbose show technical errors?
   - Current: UserError hides technical details
   - With --verbose: Show underlying error after user-friendly message?
   - **Recommendation:** Yes, add --verbose support to error formatter

## Implementation Detail

This section provides line-level implementation detail for all fixes.
For each fix, you’ll find:
- Exact file locations and line numbers
- Current code vs required changes
- Complete test cases with assertions
- Error message catalogs
- All edge cases and validation logic

**Target files based on current codebase structure:**
- Commands: `packages/blobsy/src/cli.ts` and `packages/blobsy/src/commands-stage2.ts`
- Backend: `packages/blobsy/src/backend-local.ts`, `packages/blobsy/src/backend-s3.ts`
- Core: `packages/blobsy/src/ref.ts`, `packages/blobsy/src/paths.ts`
- Config: `packages/blobsy/src/config.ts`

## References

- QA Playbook:
  [testing/qa/blobsy-end-to-end.qa.md](../../../testing/qa/blobsy-end-to-end.qa.md)
- Original Design:
  [docs/project/design/current/blobsy-design.md](../../design/current/blobsy-design.md)
- Backend Design:
  [docs/project/design/current/blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
- Phase 1 Implementation:
  [plan-2026-02-21-blobsy-phase1-implementation.md](./plan-2026-02-21-blobsy-phase1-implementation.md)
- Phase 2 Implementation:
  [plan-2026-02-21-blobsy-phase2-v1-completion.md](./plan-2026-02-21-blobsy-phase2-v1-completion.md)

## Related Beads

### High-Level Beads (Epic-level)

- **blobsy-rf23** (P0, bug): Fix #1: Auto-create local backend directories (blobsy init
  should mkdir)
- **blobsy-iqfw** (P0, bug): Fix #2: Git hooks reliability (use absolute path to blobsy
  binary)
- **blobsy-xydm** (P0, bug): Fix #3: User-friendly error messages (wrap ENOENT/EACCES
  with UserError)
- **blobsy-wcfc** (P1, feature): Fix #4: Add --remote flag to rm command (delete backend
  blobs)
- **blobsy-2igp** (P1, task): Fix #5: Document backend switching behavior in README
- **blobsy-i0g6** (P1, task): Fix #6: Document rm --local behavior in help text and
  README

### Implementation Beads (Detailed Tasks)

**Fix #1 Sub-Beads:**

- **blobsy-we2l** (P0, task): Fix #1.1: Modify backend-url.ts validation (remove
  directory check)
  - Depends on: blobsy-rf23
- **blobsy-5hub** (P0, task): Fix #1.2: Add directory creation to handleInit() in cli.ts
  - Depends on: blobsy-we2l
- **blobsy-qup6** (P0, task): Fix #1.3: Add test cases for auto-create directories
  - Depends on: blobsy-5hub

**Fix #2 Sub-Beads:**

- **blobsy-puo9** (P0, task): Fix #2.1: Modify handleHooks() to detect and use absolute
  blobsy path
  - Depends on: blobsy-iqfw
- **blobsy-o0om** (P0, task): Fix #2.2: Add test cases for hooks with absolute path
  - Depends on: blobsy-puo9

**Fix #3 Sub-Beads:**

- **blobsy-1l35** (P0, task): Fix #3.1: Create UserError class and error-messages
  catalog
  - Depends on: blobsy-xydm
- **blobsy-p7id** (P0, task): Fix #3.2: Wrap file operations in ref.ts with UserError
  - Depends on: blobsy-1l35
- **blobsy-snco** (P0, task): Fix #3.3: Wrap backend operations with UserError
  (backend-local.ts, backend-s3.ts)
  - Depends on: blobsy-1l35
- **blobsy-muez** (P0, task): Fix #3.4: Update CLI error handler in cli.ts to format
  UserError
  - Depends on: blobsy-1l35
- **blobsy-081c** (P0, task): Fix #3.5: Add test cases for UserError and error messages
  - Depends on: blobsy-p7id, blobsy-snco, blobsy-muez

**Fix #4 Sub-Beads:**

- **blobsy-3qdw** (P1, task): Fix #4.1: Update rm command definition and handleRm()
  signature
  - Depends on: blobsy-wcfc
- **blobsy-waib** (P1, task): Fix #4.2: Update rmFile() function with remote deletion
  logic
  - Depends on: blobsy-3qdw
- **blobsy-j7y9** (P1, task): Fix #4.3: Add test cases for rm --remote command
  - Depends on: blobsy-waib

### Bead Dependency Summary

```
Fix #1:
  blobsy-rf23 → blobsy-we2l → blobsy-5hub → blobsy-qup6

Fix #2:
  blobsy-iqfw → blobsy-puo9 → blobsy-o0om

Fix #3:
  blobsy-xydm → blobsy-1l35 → [blobsy-p7id, blobsy-snco, blobsy-muez] → blobsy-081c

Fix #4:
  blobsy-wcfc → blobsy-3qdw → blobsy-waib → blobsy-j7y9

Fix #5:
  blobsy-2igp (no sub-beads - documentation only)

Fix #6:
  blobsy-i0g6 (no sub-beads - documentation only)
```

**Total Beads:** 25 (6 high-level + 19 implementation tasks)
