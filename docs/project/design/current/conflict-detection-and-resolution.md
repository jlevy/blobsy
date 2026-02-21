# Conflict Detection and Resolution in blobsy

**Status:** Draft Design

**Date:** 2026-02-20

**Context:** This document addresses the critical race condition identified in design
reviews where git pull updates .yref files but leaves local payload files stale, causing
blobsy sync to incorrectly revert changes.

## Problem Statement

### The Core Issue

blobsy faces a fundamental challenge: **Git tracks .yref files but not the payload files
themselves** (which are gitignored).
This creates scenarios where the .yref and payload can become desynchronized.

### The Critical Race Condition

**Scenario:**
```bash
# User A modifies file and syncs
$ echo "new content" > model.bin
$ blobsy track model.bin           # .yref hash = abc123 (new)
$ blobsy push model.bin            # Uploads new blob
$ git add model.bin.yref && git commit && git push

# User B on different machine
$ ls model.bin                      # Still has old content, hash = def456
$ git pull                          # Updates model.bin.yref to hash = abc123
                                    # But Git IGNORES model.bin (gitignored)

# User B's state:
# - model.bin on disk: old content (hash = def456)
# - model.bin.yref: new hash (abc123, from User A)

$ blobsy sync
# WRONG BEHAVIOR: Sees local != ref, assumes user modified file
# Overwrites .yref with old hash, pushes old blob
# User A's changes are REVERTED (data loss!)
```

**Root Cause:** Cannot distinguish between:
1. **User modified the file locally** (should push new version)
2. **Git updated the .yref but file is stale** (should pull new version)

### The Underlying Cause

The race condition exists because **users can commit .yref files to git without first
pushing the blobs to remote storage**. When this happens:

1. User A commits .yref with hash X but forgets to `blobsy push`
2. User B pulls from git, gets .yref with hash X
3. User B runs `blobsy pull`, but blob for hash X doesn’t exist remotely
4. Error: “missing (no remote!)”

Or worse:
1. User A has both old local file and new .yref (not yet pushed)
2. User A commits .yref but forgets to push blob
3. User B pulls, runs `blobsy sync`
4. User B’s blobsy sees local file differs from .yref, pushes wrong version

## Solution: Defense in Depth

We use a **three-layer defense**:

1. **Prevention (Primary):** Pre-commit hook ensures blobs are pushed before .yref files
   are committed
2. **Detection (Secondary):** Stat cache-based three-way merge detects and resolves
   conflicts
3. **Attribution (Tertiary):** Clear error messages identify who committed without
   pushing

* * *

## Layer 1: Prevention via Pre-Commit Hook

### Recommended User Workflow

The recommended sequence is:
```bash
1. blobsy track <file>      # Create/update .yref
2. blobsy push <file>       # Upload blob to remote
3. git add *.yref           # Stage .yref files
4. git commit               # Commit (hook auto-pushes if needed)
5. git push                 # Share with team
```

However, users may forget step 2 or do steps out of order.

### The Pre-Commit Hook (Installed by `blobsy init`)

**Location:** `.git/hooks/pre-commit`

**Behavior:**
- Detects if any `.yref` files are being committed
- If yes: automatically runs `blobsy push` for those files
  - `blobsy push` performs sanity checks (see below)
  - Verifies .yref hash matches actual file content
  - Uploads blob to remote
  - Updates .yref with remote_key
- If push succeeds: allow commit
- If push fails: block commit with helpful error

**Sanity Checks (performed by `blobsy push`):**
1. Read .yref file hash
2. Hash actual file on disk
3. Compare hashes
4. If mismatch → ERROR (unless `--force`)
5. If match → proceed with upload

**Implementation:**

```bash
#!/bin/bash
# .git/hooks/pre-commit
# Installed by: blobsy init
# Purpose: Ensure blobs are pushed before committing .yref files

# Find all .yref files being committed (staged for commit)
YREF_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.yref$')

if [ -z "$YREF_FILES" ]; then
  # No .yref files being committed - nothing to do
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "blobsy pre-commit hook"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Detected $(echo "$YREF_FILES" | wc -l) .yref file(s) in this commit:"
echo "$YREF_FILES" | sed 's/^/  /'
echo ""
echo "Running 'blobsy push' to ensure blobs are uploaded before commit..."
echo ""

# Extract original file paths from .yref paths
# (remove .yref suffix to get original file path)
FILE_PATHS=$(echo "$YREF_FILES" | sed 's/\.yref$//')

# Push only the files whose .yref is being committed
if echo "$FILE_PATHS" | xargs blobsy push --quiet; then
  echo ""
  echo "✓ All blobs uploaded successfully"

  # CRITICAL: Re-stage .yref files that were updated by blobsy push
  # (blobsy push writes remote_key back into the .yref files)
  echo "$YREF_FILES" | xargs git add

  echo "  Proceeding with commit..."
  exit 0
else
  EXIT_CODE=$?
  echo ""
  echo "✗ Failed to upload one or more blobs (exit code: $EXIT_CODE)"
  echo ""
  echo "Your commit has been BLOCKED to prevent committing .yref files"
  echo "without their corresponding remote blobs."
  echo ""
  echo "This prevents other users from getting 'missing (no remote!)' errors."
  echo ""
  echo "Options:"
  echo "  1. Fix the upload issue (check network, credentials, backend config)"
  echo "     Then retry: git commit"
  echo ""
  echo "  2. Skip this check (NOT RECOMMENDED unless you know what you're doing):"
  echo "     git commit --no-verify"
  echo ""
  echo "  3. Unstage the .yref files and commit other changes:"
  echo "     git reset HEAD *.yref"
  echo "     git commit"
  echo ""
  exit 1
fi
```

### Hook Installation

**During `blobsy init`:**
```bash
$ blobsy init --bucket my-data --region us-east-1

Created .blobsy.yml
Backend configured: s3 (bucket: my-data, region: us-east-1)

Installing git hooks...
  ✓ .git/hooks/pre-commit (ensures blobs are pushed before commit)

Recommendation: Keep this hook installed to prevent sync issues.
If you need to skip it for a specific commit, use: git commit --no-verify
```

**Manual installation:**
```bash
$ blobsy hooks install
✓ Installed pre-commit hook
```

**Manual uninstallation:**
```bash
$ blobsy hooks uninstall
✓ Removed pre-commit hook
```

**Check hook status:**
```bash
$ blobsy doctor
...
Git hooks:
  ✓ pre-commit hook installed (.git/hooks/pre-commit)
    Purpose: Auto-push blobs when committing .yref files
    Status: Active
```

### Benefits of This Approach

1. **Automatic:** Users don’t need to remember to push before commit
2. **No-op when not needed:** If no .yref files in commit, hook exits immediately
3. **Clear feedback:** Users see exactly what’s happening
4. **Escapable:** Can skip with `--no-verify` if truly needed
5. **Team-wide:** Hook is local but recommended in docs, so all team members benefit
6. **Fail-safe:** Blocks commit if push fails, preventing bad state

### When Users Skip the Hook

Users can skip the hook with:
```bash
$ git commit --no-verify
```

This is when **Layer 2 (stat cache detection)** becomes critical.

* * *

## Sanity Checks in `blobsy push`

Before uploading any blob, `blobsy push` verifies consistency:

```typescript
async function push(filePath: string, options: PushOptions = {}): Promise<void> {
  // 1. Read .yref file
  const yrefPath = filePath + '.yref';
  if (!await exists(yrefPath)) {
    throw new Error(`No .yref file found for ${filePath}. Run 'blobsy track' first.`);
  }

  const ref = await readYRef(yrefPath);

  // 2. Hash actual file
  if (!await exists(filePath)) {
    throw new Error(
      `File not found: ${filePath}\n` +
      `\n` +
      `The .yref file exists but the actual file is missing.\n` +
      `Run 'blobsy pull ${filePath}' to download it.`
    );
  }

  const actualHash = await computeHash(filePath);

  // 3. Verify hash matches (CRITICAL SANITY CHECK)
  if (actualHash !== ref.hash && !options.force) {
    throw new Error(
      `Hash mismatch in ${filePath}:\n` +
      `\n` +
      `  Expected (in .yref): ${ref.hash}\n` +
      `  Actual (file):       ${actualHash}\n` +
      `\n` +
      `This means the file was modified after the .yref was created.\n` +
      `This is likely one of these scenarios:\n` +
      `\n` +
      `  1. You edited the file but forgot to run 'blobsy track' again\n` +
      `  2. The .yref file is corrupted or manually edited incorrectly\n` +
      `  3. The file was modified by another process\n` +
      `\n` +
      `To fix:\n` +
      `  1. Update the .yref to match current file: blobsy track ${filePath}\n` +
      `  2. Restore file to match .yref: blobsy pull --force ${filePath}\n` +
      `  3. Force push current file (DANGER): blobsy push --force ${filePath}\n`
    );
  }

  if (actualHash !== ref.hash && options.force) {
    console.warn(`⚠ WARNING: Forcing push with hash mismatch`);
    console.warn(`  .yref hash: ${ref.hash}`);
    console.warn(`  File hash:  ${actualHash}`);
    console.warn(`  The .yref will be updated to match the current file.`);

    // Update ref to match actual file
    ref.hash = actualHash;
    ref.size = await getFileSize(filePath);
    await writeYRef(yrefPath, ref);
  }

  // 4. Proceed with upload
  const remoteKey = await uploadBlob(filePath, ref);

  // 5. Update .yref with remote_key
  ref.remote_key = remoteKey;
  await writeYRef(yrefPath, ref);

  // 6. Update stat cache
  const stats = await stat(filePath);
  await statCache.set(filePath, {
    hash: ref.hash,
    size: ref.size,
    mtimeNs: stats.mtimeNs.toString(),  // BigInt to string for JSON
    cachedAt: Date.now()
  });

  console.log(`✓ Pushed ${filePath} (${formatSize(ref.size)})`);
}
```

This sanity check is **critical** because it catches:

1. **File modified after tracking:**
   ```bash
   $ blobsy track model.bin      # Creates .yref with hash abc123
   $ echo "oops" >> model.bin    # File now has hash def456
   $ git commit                  # Pre-commit hook runs blobsy push
   # ERROR: Hash mismatch! File was modified.
   ```

2. **Corrupted .yref file:**
   ```bash
   $ vim model.bin.yref          # User accidentally edits hash field
   $ git commit
   # ERROR: Hash mismatch! .yref is corrupted.
   ```

3. **Concurrent modification:**
   ```bash
   $ blobsy track model.bin      # Hash abc123
   # Another process modifies model.bin
   $ git commit
   # ERROR: Hash mismatch! File was modified externally.
   ```

* * *

## Layer 2: Detection via Stat Cache Three-Way Merge

### Purpose

When the pre-commit hook is skipped or in edge cases (manual .yref edits, merge
conflicts), we need to detect conflicts at sync time.

### The Stat Cache as Merge Base

The stat cache stores the **last-known state** of each file when blobsy last interacted
with it:

```typescript
interface StatCacheEntry {
  hash: string;      // SHA-256 hash of file content
  size: number;      // File size in bytes
  mtimeNs: string;   // Modification time in nanoseconds (string: "1708468523000000000")
  cachedAt: number;  // Timestamp when this was cached (milliseconds since epoch)
}
```

**Note:** `mtimeNs` is stored as a string because JSON does not natively support BigInt
values. Use `BigInt(entry.mtimeNs)` when parsing and `stats.mtimeNs.toString()` when
serializing.

**Key Insight:** The stat cache is the **merge base** for three-way conflict detection.

### Three-Way Merge Algorithm

For each tracked file:

1. **Local state:** Hash of file on disk
2. **Remote state:** Hash in `.yref` file (from git)
3. **Base state:** Hash in stat cache (last time blobsy touched this file)

**Decision table:**

| Local Hash | .yref Hash | Cache Hash | Interpretation | Action |
| --- | --- | --- | --- | --- |
| A | A | A | No changes anywhere | Nothing (✓) |
| A | A | (none) | First time tracking | Nothing (✓) |
| A | B | A | .yref updated by git pull, local unchanged | **Pull new blob** |
| B | A | A | User modified file, .yref unchanged | **Push new version** |
| B | B | A | User modified + already synced | Nothing (✓) |
| B | C | A | **Conflict:** Both local and .yref changed | **Error (manual resolution)** |

### Implementation

```typescript
async function sync(filePath: string): Promise<void> {
  const localHash = await computeHash(filePath);
  const ref = await readYRef(filePath + '.yref');
  const cached = await statCache.get(filePath);

  // Case 1: Everything matches
  if (localHash === ref.hash) {
    if (!cached || cached.hash === localHash) {
      // All in sync
      console.log(`✓ ${filePath} (in sync)`);
      return;
    }
  }

  // Case 2: First time (no cache entry)
  if (!cached) {
    if (localHash === ref.hash) {
      // First time seeing this file, already in sync
      const stats = await stat(filePath);
      await statCache.set(filePath, {
        hash: localHash,
        size: stats.size,
        mtimeNs: stats.mtimeNs.toString(),
        cachedAt: Date.now()
      });
      console.log(`✓ ${filePath} (first sync)`);
      return;
    } else {
      // First time, local differs from ref - AMBIGUOUS without cache
      throw new Error(
        `Cannot sync ${filePath}: no stat cache entry (first time or cache lost).\n` +
        `\n` +
        `Local file hash:  ${localHash.substring(0, 12)}...\n` +
        `.yref hash:       ${ref.hash.substring(0, 12)}...\n` +
        `\n` +
        `Without stat cache, cannot distinguish:\n` +
        `  1. You just tracked this file (should push local version)\n` +
        `  2. Git pull updated .yref but local is stale (should pull remote version)\n` +
        `\n` +
        `Resolution:\n` +
        `  - If this is a NEW file you just tracked: blobsy push ${filePath}\n` +
        `  - If you just pulled from git: blobsy pull ${filePath}\n` +
        `  - If unsure: check git log for .yref changes\n`
      );
    }
  }

  // Case 3: git pull updated .yref, local unchanged
  if (localHash === cached.hash && ref.hash !== cached.hash) {
    console.log(`↓ ${filePath} (pulling update from git)`);

    if (!ref.remote_key) {
      throw new Error(
        `Cannot pull ${filePath}: .yref has no remote_key.\n` +
        `\n` +
        `This means someone committed the .yref file without pushing the blob.\n` +
        `\n` +
        `To fix:\n` +
        `  1. Ask the person who committed this .yref to run: blobsy push ${filePath}\n` +
        `  2. Or if you have the correct file locally, run: blobsy push --force ${filePath}\n` +
        `\n` +
        `Last commit of this .yref:\n` +
        `  ${await getLastCommitInfo(filePath + '.yref')}`
      );
    }

    await pullBlob(filePath, ref.remote_key);
    const stats = await stat(filePath);
    await statCache.set(filePath, {
      hash: ref.hash,
      size: ref.size,
      mtimeNs: stats.mtimeNs.toString(),
      cachedAt: Date.now()
    });
    return;
  }

  // Case 4: User modified file, .yref unchanged
  if (localHash !== cached.hash && ref.hash === cached.hash) {
    console.log(`↑ ${filePath} (pushing local modification)`);
    await updateRefAndPush(filePath, localHash);
    return;
  }

  // Case 5: Both changed (conflict)
  if (localHash !== cached.hash && ref.hash !== cached.hash && localHash !== ref.hash) {
    throw new ConflictError(
      `Conflict in ${filePath}:\n` +
      `\n` +
      `  Local file:    ${localHash.substring(0, 12)}... (modified by you)\n` +
      `  .yref file:    ${ref.hash.substring(0, 12)}... (modified in git)\n` +
      `  Last known:    ${cached.hash.substring(0, 12)}... (merge base)\n` +
      `\n` +
      `Both the local file and the .yref have changed since last sync.\n` +
      `This means you modified the file locally while someone else pushed a different version.\n` +
      `\n` +
      `Last commit of this .yref:\n` +
      `  ${await getLastCommitInfo(filePath + '.yref')}\n` +
      `\n` +
      `Resolution options:\n` +
      `  1. Keep your local version:  blobsy push --force ${filePath}\n` +
      `  2. Take remote version:      blobsy pull --force ${filePath}\n` +
      `  3. Manually merge:           (edit file, then blobsy track ${filePath})\n`
    );
  }
}
```

### Stat Cache Correctness Requirements

**Critical:** The stat cache must be updated atomically with file operations:

1. **After `blobsy track`:** Update cache with new hash
2. **After `blobsy push`:** Update cache to match pushed version
3. **After `blobsy pull`:** Update cache to match pulled version
4. **Never in between:** Don’t update cache without completing the operation

**Cache invalidation:**
- File size changes → invalidate
- File mtime changes (nanosecond precision) → invalidate
- Cache entry older than 30 days → revalidate on next access

**Cache storage:**
```
.blobsy/stat-cache.json (gitignored, machine-local)
```

* * *

## Layer 3: Attribution and Error Messages

### When Someone Commits Without Pushing

**Error message when pulling:**

```bash
$ blobsy pull

✗ data/model.bin: Cannot pull (no remote blob)

This .yref file references a blob that doesn't exist in remote storage:
  Expected remote key: 20260220T140322Z-abc123/data/model.bin
  Remote backend: s3://my-bucket/project/

This usually means someone committed the .yref file without pushing the blob.

Last commit of this .yref:
  commit: a1b2c3d4
  author: Alice <alice@example.com>
  date:   2026-02-20 14:03:22
  message: Update model

To fix:
  1. Ask Alice to run: blobsy push data/model.bin
  2. Or if you have the correct file, run: blobsy push --force data/model.bin
  3. Or run: blobsy doctor --check-unpushed (to find all such files)
```

### Helpful Commands

**Check for unpushed blobs:**
```bash
$ blobsy check-unpushed

Scanning git history for committed .yref files...

⚠ Found 2 .yref files in HEAD with missing remote blobs:

  data/model.bin.yref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Commit: a1b2c3d4
    Issue: remote_key not set (never pushed)

  results/output.json.yref
    Committed: 2026-02-19 09:15:44
    Author: Bob <bob@example.com>
    Commit: e5f6g7h8
    Issue: remote blob not found at key (might have been deleted)

To fix:
  Run 'blobsy push' to upload missing blobs.
  Then commit the updated .yref files: git add *.yref && git commit -m "Add remote keys"
```

**Check before pushing to git:**
```bash
$ blobsy pre-push-check

✓ All committed .yref files have remote blobs
  Checked 15 .yref files in HEAD
  All blobs reachable

Safe to push to git: git push
```

* * *

## Implementation Checklist

### V1 Requirements

- [ ] Pre-commit hook implementation
  - [ ] Hook script template
  - [ ] `blobsy init` installs hook
  - [ ] `blobsy hooks install/uninstall` commands
  - [ ] `blobsy doctor` checks hook status
  - [ ] Documentation on hook behavior

- [ ] Sanity checks in `blobsy push`
  - [ ] Verify .yref hash matches file content
  - [ ] Error with helpful message if mismatch
  - [ ] `--force` flag to override (updates .yref to match file)
  - [ ] Prevent corrupted or stale .yref files from being pushed

- [ ] Stat cache as merge base
  - [ ] Elevate from optional to mandatory
  - [ ] Nanosecond mtime precision
  - [ ] Atomic cache updates
  - [ ] Three-way merge algorithm
  - [ ] Conflict detection and reporting

- [ ] Attribution and error messages
  - [ ] `blobsy check-unpushed` command
  - [ ] `blobsy pre-push-check` command (for CI)
  - [ ] Git blame integration in error messages
  - [ ] Clear troubleshooting guidance

- [ ] Testing
  - [ ] Test: git pull with stale local file
  - [ ] Test: local edit with unchanged .yref
  - [ ] Test: three-way conflict
  - [ ] Test: hook prevents bad commits
  - [ ] Test: hook can be skipped with --no-verify
  - [ ] Test: multiple users concurrent edits

### Documentation

- [ ] Update main design doc with conflict resolution section
- [ ] Add troubleshooting guide for conflict scenarios
- [ ] Document recommended workflow (track → push → commit)
- [ ] Document hook installation and behavior
- [ ] Add examples of conflict resolution

* * *

## FAQ

### Q: What if I don’t want the pre-commit hook?

You can skip it on a per-commit basis:
```bash
git commit --no-verify
```

Or uninstall it:
```bash
blobsy hooks uninstall
```

However, you’ll need to manually ensure you push blobs before committing .yref files.

### Q: What if two users modify the same file concurrently?

The stat cache three-way merge will detect this as a conflict:
```
Conflict in data/model.bin:
  Local file:    abc123... (modified by you)
  .yref file:    def456... (modified in git)
  Last known:    xyz789... (merge base)
```

You’ll need to manually resolve (choose one version or merge manually).

### Q: What if the stat cache is corrupted or missing?

blobsy will fall back to conservative behavior:
- If local matches .yref: assume in sync
- If local differs from .yref: warn and ask user to clarify intent

You can rebuild the cache:
```bash
blobsy verify --rebuild-cache
```

### Q: What happens in a merge conflict in git?

If two branches modify the same .yref file, git will create a merge conflict in the
.yref file itself. You resolve this like any git merge conflict, then run `blobsy sync`
to pull the winning blob.

### Q: Can I batch-commit multiple .yref files?

Yes, the pre-commit hook will push all files whose .yref is being committed:
```bash
git add *.yref
git commit -m "Update 50 files"
# Hook runs: blobsy push file1.bin file2.bin ... file50.bin
```

### Q: What if I modified a file after running `blobsy track` but before committing?

The sanity check in `blobsy push` will catch this:
```bash
$ blobsy track model.bin         # .yref hash = abc123
$ echo "more data" >> model.bin  # File hash now = def456
$ git add model.bin.yref
$ git commit
# Pre-commit hook runs blobsy push
# ERROR: Hash mismatch!
#   Expected: abc123
#   Actual: def456
# File was modified after tracking.
# Run 'blobsy track model.bin' to update the .yref.
```

This prevents inconsistent state from being committed.

### Q: Can I bypass the sanity check?

Yes, with `--force`:
```bash
$ blobsy push --force model.bin
```

This will:
1. Update the .yref to match the current file content
2. Push the current version

Use this only if you’re certain you want to push the current file state.

* * *

## Comparison to Other Tools

**Git LFS:** Prevents this by integrating with `git push` - LFS upload happens during
git push, atomically.

**DVC:** Similar issue - you can `git commit` .dvc files without `dvc push`, leading to
“not in cache” errors on other machines.

**blobsy:** Uses pre-commit hook (automatic but skippable) + stat cache three-way merge
(fallback) for defense in depth.

* * *

## Future Enhancements (V2+)

1. **Pre-push hook:** Additional check before `git push` to verify all .yref files have
   blobs
2. **CI integration:** GitHub Actions workflow to verify on PR
3. **Server-side validation:** Optional remote endpoint that validates .yref consistency
4. **Automatic repair:** `blobsy repair` command that fixes inconsistencies
