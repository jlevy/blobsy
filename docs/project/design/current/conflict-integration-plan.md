# Integration Plan: Conflict Detection → Main Design

**Date:** 2026-02-20

**Goal:** Methodically integrate `conflict-detection-and-resolution.md` into
`blobsy-design-v2.md` and verify consistency.

## Integration Points

### 1. Integrity Model Section (Lines 741-848)

**Current:** Stat cache described as performance optimization only.

**Integration needed:**
````markdown
### Local Stat Cache

The stat cache serves TWO critical purposes:

1. **Performance optimization** - Fast-path to avoid re-hashing unchanged files
2. **Conflict detection** - Merge base for three-way conflict resolution

#### Stat Cache as Performance Optimization

[Keep existing content lines 796-836]

#### Stat Cache as Merge Base (NEW)

The stat cache stores the last-known state when blobsy interacted with each file:

```typescript
interface StatCacheEntry {
  hash: string;      // SHA-256 hash of file content
  size: number;      // File size in bytes
  mtimeNs: string;   // Modification time in nanoseconds (BigInt as string)
  cachedAt: number;  // Timestamp when cached (ms since epoch)
}
````

**Critical insight:** The stat cache is the **merge base** for three-way conflict
detection.

For each tracked file, blobsy has three states:
- **Local state:** Hash of file on disk
- **Remote state:** Hash in `.yref` file (from git)
- **Base state:** Hash in stat cache (last time blobsy touched this file)

This enables detecting:
- **Git pull updated .yref, local unchanged** → Pull new blob
- **User modified file, .yref unchanged** → Push new version
- **Both changed** → Conflict (manual resolution)

See [Conflict Detection](#conflict-detection-and-resolution) for full algorithm.

#### Stat Cache Correctness Requirements (NEW)

The stat cache MUST be updated atomically with file operations:

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

The stat cache is mandatory for correctness in operations that modify .yref files.
If missing, blobsy auto-rebuilds it (hashes all files, warns it’s slow).
````

**Consistency check:** ✅ No conflicts. Expands existing section.

---

### 2. Conflict Model Section (Lines 2384-2436)

**Current:** Basic explanation of git conflicts on .yref files.

**Integration needed:** Replace with comprehensive conflict detection section.

**Location:** Lines 2384-2436 (replace entire section)

**New content:**
```markdown
## Conflict Detection and Resolution

### The Critical Race Condition

Blobsy faces a fundamental challenge: **Git tracks .yref files but not the payload files** (which are gitignored). This creates scenarios where the .yref and payload become desynchronized.

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
# WRONG BEHAVIOR (without conflict detection):
# Sees local != ref, assumes user modified file
# Overwrites .yref with old hash, pushes old blob
# User A's changes are REVERTED (data loss!)
````

**Root cause:** Cannot distinguish between:
1. **User modified the file locally** (should push new version)
2. **Git updated the .yref but file is stale** (should pull new version)

### Three-Layer Defense Strategy

Blobsy uses defense in depth to prevent this race condition:

1. **Prevention (Primary):** Pre-commit hook ensures blobs are pushed before .yref files
   are committed
2. **Detection (Secondary):** Stat cache-based three-way merge detects and resolves
   conflicts
3. **Attribution (Tertiary):** Clear error messages identify who committed without
   pushing

* * *

#### Layer 1: Prevention via Pre-Commit Hook

##### Recommended Workflow

```bash
1. blobsy track <file>      # Create/update .yref
2. blobsy push <file>       # Upload blob to remote
3. git add *.yref           # Stage .yref files
4. git commit               # Commit (hook auto-pushes if needed)
5. git push                 # Share with team
```

However, users may forget step 2 or do steps out of order.

##### The Pre-Commit Hook (Installed by `blobsy init`)

**Location:** `.git/hooks/pre-commit`

**Behavior:**
- Detects if any `.yref` files are being committed
- If yes: automatically runs `blobsy push` for those files
  - `blobsy push` performs sanity checks (hash verification)
  - Uploads blob to remote
  - Updates .yref with remote_key
- If push succeeds: allow commit
- If push fails: block commit with helpful error

**Sanity checks (performed by `blobsy push`):**
1. Read .yref file hash
2. Hash actual file on disk
3. Compare hashes
4. If mismatch → ERROR (unless `--force`)
5. If match → proceed with upload

**Hook installation:**

During `blobsy init`:
```bash
$ blobsy init --bucket my-data --region us-east-1

Created .blobsy.yml
Backend configured: s3 (bucket: my-data, region: us-east-1)

Installing git hooks...
  ✓ .git/hooks/pre-commit (ensures blobs are pushed before commit)

Recommendation: Keep this hook installed to prevent sync issues.
If you need to skip it for a specific commit, use: git commit --no-verify
```

**Manual hook management:**
```bash
$ blobsy hooks install    # Install hook
$ blobsy hooks uninstall  # Remove hook
```

**Bypass hook (when truly needed):**
```bash
$ git commit --no-verify  # Skip pre-commit hook
```

##### Sanity Checks in `blobsy push`

Before uploading any blob, `blobsy push` verifies consistency:

```typescript
async function push(filePath: string, options: PushOptions = {}): Promise<void> {
  // 1. Read .yref file
  const yrefPath = filePath + '.yref';
  const ref = await readYRef(yrefPath);

  // 2. Hash actual file
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
      `\n` +
      `To fix:\n` +
      `  1. Update the .yref: blobsy track ${filePath}\n` +
      `  2. Restore file: blobsy pull --force ${filePath}\n` +
      `  3. Force push: blobsy push --force ${filePath} (DANGER)\n`
    );
  }

  // 4. Proceed with upload...
}
```

This catches:
1. File modified after tracking
2. Corrupted .yref file
3. Concurrent modification

* * *

#### Layer 2: Detection via Stat Cache Three-Way Merge

When the pre-commit hook is skipped or in edge cases, the stat cache detects conflicts
at sync time.

##### Three-Way Merge Algorithm

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
| A | B | B | User reverted file to old version | **Pull or warn** |
| B | C | A | **Conflict:** Both local and .yref changed | **Error (manual resolution)** |

##### Implementation

```typescript
async function sync(filePath: string): Promise<void> {
  const localHash = await computeHash(filePath);
  const ref = await readYRef(filePath + '.yref');
  const cached = await statCache.get(filePath);

  // Case 1: Everything matches
  if (localHash === ref.hash) {
    console.log(`✓ ${filePath} (in sync)`);
    return;
  }

  // Case 2: First time (no cache entry)
  if (!cached) {
    if (localHash === ref.hash) {
      await updateStatCache(filePath, localHash);
      return;
    } else {
      // First time, local differs - assume local is truth
      await updateRefAndPush(filePath, localHash);
      return;
    }
  }

  // Case 3: git pull updated .yref, local unchanged
  if (localHash === cached.hash && ref.hash !== cached.hash) {
    console.log(`↓ ${filePath} (pulling update from git)`);

    if (!ref.remote_key) {
      throw new Error(
        `Cannot pull ${filePath}: .yref has no remote_key.\n` +
        `\n` +
        `Someone committed the .yref without pushing the blob.\n` +
        `\n` +
        `Last commit of this .yref:\n` +
        `  ${await getLastCommitInfo(filePath + '.yref')}\n` +
        `\n` +
        `To fix: Ask them to run: blobsy push ${filePath}\n`
      );
    }

    await pullBlob(filePath, ref.remote_key);
    await updateStatCache(filePath, ref.hash);
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
      `Both the local file and .yref changed since last sync.\n` +
      `\n` +
      `Last commit of this .yref:\n` +
      `  ${await getLastCommitInfo(filePath + '.yref')}\n` +
      `\n` +
      `Resolution:\n` +
      `  1. Keep local:  blobsy push --force ${filePath}\n` +
      `  2. Take remote: blobsy pull --force ${filePath}\n` +
      `  3. Manual merge: (edit file, then blobsy track ${filePath})\n`
    );
  }
}
```

* * *

#### Layer 3: Attribution and Error Messages

When someone commits without pushing, blobsy identifies who did it:

```bash
$ blobsy pull

✗ data/model.bin: Cannot pull (no remote blob)

This .yref file references a blob that doesn't exist in remote storage:
  Expected remote key: 20260220T140322Z-abc123/data/model.bin
  Remote backend: s3://my-bucket/project/

Last commit of this .yref:
  commit: a1b2c3d4
  author: Alice <alice@example.com>
  date:   2026-02-20 14:03:22
  message: Update model

To fix:
  1. Ask Alice to run: blobsy push data/model.bin
  2. Or if you have the correct file: blobsy push --force data/model.bin
```

##### Helper Commands

**Check for unpushed blobs:**
```bash
$ blobsy check-unpushed

Scanning git history for committed .yref files...

⚠ Found 2 .yref files in HEAD with missing remote blobs:

  data/model.bin.yref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Issue: remote_key not set (never pushed)

To fix: Run 'blobsy push' to upload missing blobs.
```

**Pre-push check (for CI):**
```bash
$ blobsy pre-push-check

✓ All committed .yref files have remote blobs
  Checked 15 .yref files in HEAD

Safe to push to git: git push
```

* * *

### Git Merge Conflicts on .yref Files

When two users modify the same file concurrently, git creates a merge conflict in the
.yref file:

```
<<<<<<< HEAD
hash: sha256:aaa111...
size: 1048576
=======
hash: sha256:ccc333...
size: 2097152
>>>>>>> origin/main
```

**Resolution (standard git workflow):**

```bash
# Accept theirs
$ git checkout --theirs data/results.json.yref
$ git add data/results.json.yref
$ blobsy pull data/results.json    # get their version of the actual file

# Or accept ours
$ git checkout --ours data/results.json.yref
$ git add data/results.json.yref
# Our blob already pushed, nothing to do

$ git commit -m "Resolve: take their results"
```

No custom resolution tooling needed.
Standard git conflict resolution works.

* * *

### Single-Writer Model (V1)

Blobsy assumes one writer per tracked file at a time.
This is the common case.

Content-addressable storage means:
- Concurrent pushes of different files never interfere (different content → different
  keys)
- Concurrent pushes of same content → idempotent PUT (same key)
- Concurrent pushes of different content → both blobs exist; git merge determines winner

### Comparison to Other Tools

**Git LFS:** Prevents this by integrating with `git push` - LFS upload happens during
git push, atomically.

**DVC:** Similar issue - you can `git commit` .dvc files without `dvc push`, leading to
“not in cache” errors.

**blobsy:** Three-layer defense (pre-commit hook + stat cache three-way merge +
attribution).
````

**Consistency check:**
- ✅ Replaces existing simple conflict model with comprehensive version
- ✅ Consistent with stat cache changes in section #1
- ⚠️ **NOTE:** This completely rewrites the conflict model section. Review to ensure it doesn't contradict anything else in the doc.

---

### 3. CLI Commands Section (Lines 849-1514)

**Current:** Commands documented, but missing conflict-related commands.

**Integration needed:** Add new commands.

**Location:** After `blobsy doctor` (around line 1476), before "Command Summary" (line 1487)

**New content:**
```markdown
### `blobsy hooks`

Manage git hooks for blobsy.

**Install hooks:**
```bash
$ blobsy hooks install
✓ Installed pre-commit hook (.git/hooks/pre-commit)
````

**Uninstall hooks:**
```bash
$ blobsy hooks uninstall
✓ Removed pre-commit hook
```

**Check status:**
```bash
$ blobsy doctor
...
Git hooks:
  ✓ pre-commit hook installed (.git/hooks/pre-commit)
    Purpose: Auto-push blobs when committing .yref files
    Status: Active
```

The pre-commit hook automatically runs `blobsy push` when you commit .yref files,
ensuring blobs are uploaded before the commit completes.

To bypass the hook for a specific commit:
```bash
$ git commit --no-verify
```

### `blobsy check-unpushed`

Find committed .yref files with missing remote blobs.

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
    Issue: remote blob not found (might have been deleted)

To fix:
  Run 'blobsy push' to upload missing blobs.
  Then commit updated .yref files: git add *.yref && git commit -m "Add remote keys"
```

**Flags:**
- `--json` - Machine-readable output for CI

**Use case:** Diagnostic tool when team members report “missing (no remote!)” errors.

### `blobsy pre-push-check`

Verify all committed .yref files have remote blobs (CI-friendly).

```bash
$ blobsy pre-push-check

✓ All committed .yref files have remote blobs
  Checked 15 .yref files in HEAD
  All blobs reachable

Safe to push to git: git push
```

**Exit codes:**
- `0` - All .yref files have blobs
- `1` - One or more .yref files missing blobs

**Use case:** Run in CI before allowing merge.
Prevents commits with missing blobs from entering main branch.

**Example CI workflow:**
```yaml
# .github/workflows/check-blobs.yml
- name: Check all blobs are pushed
  run: npx blobsy pre-push-check
```

````

**Update Command Summary (line 1487):**

```diff
 SETUP
   blobsy init                          Initialize blobsy in a git repo
   blobsy config [key] [value]          Get/set configuration
   blobsy health                        Check transport backend health (credentials, connectivity)
   blobsy doctor                        Comprehensive diagnostics and health check (V2: enhanced)
        [--fix]                       Auto-fix detected issues
+  blobsy hooks install                 Install git hooks (pre-commit)
+  blobsy hooks uninstall               Remove git hooks

 TRACKING
   blobsy track <path>...               Start tracking a file or directory (creates/updates .yref)
   blobsy untrack [--recursive] <path>  Stop tracking, keep local file (move .yref to trash)
   blobsy rm [--local|--recursive] <path>  Remove from tracking and delete local file
   blobsy mv <source> <dest>            Rename/move tracked file (V1: files only, preserves remote_key)

 SYNC
   blobsy sync [path...]                Bidirectional: track changes, push missing, pull missing
   blobsy push [path...]                Upload local blobs to remote, set remote_key
        [--force]                     Force push even if hash mismatch (updates .yref to match file)
   blobsy pull [path...]                Download remote blobs to local
        [--force]                     Overwrite local modifications
   blobsy status [path...]              Show state of all tracked files (○ ◐ ◑ ✓ ~ ? ⊗) (V2: with sizes)
   blobsy stats                         Show aggregate statistics by state (V2: new command)
+  blobsy check-unpushed                Find committed .yref files with missing remote blobs
+  blobsy pre-push-check                Verify all committed .yref files have blobs (CI)

 VERIFICATION
   blobsy verify [path...]              Verify local files match ref hashes
````

**Consistency check:** ✅ Adds new commands without conflict.

* * *

### 4. Corner Cases Section (Lines 2708+)

**Current:** Has “Push/Commit Coordination” subsection that partially covers this.

**Integration needed:** Expand this subsection with the race condition details.

**Location:** Replace/expand lines 2709-2733

**New content:**
````markdown
### Push/Commit Coordination

#### The Race Condition (Critical)

**Git pull desync:** User A pushes changes. User B runs `git pull`. Git updates the `.yref` file but NOT the payload (which is gitignored). User B's local file is now stale.

**Without conflict detection:**
```bash
# User A
$ echo "new" > model.bin
$ blobsy track model.bin           # .yref hash = abc123
$ blobsy push model.bin && git commit && git push

# User B
$ git pull                          # .yref updated to abc123
                                    # model.bin unchanged (still old content, hash def456)
$ blobsy sync
# BUG: Sees local (def456) != ref (abc123), assumes user modified file
# Pushes old content, reverts User A's changes!
````

**With conflict detection (stat cache):**
```bash
# User B
$ git pull                          # .yref updated to abc123
$ blobsy sync
# Stat cache has def456 (last known state)
# Local has def456 (unchanged)
# .yref has abc123 (changed in git)
# → Three-way merge detects: "git pull updated .yref, local unchanged"
# → Pulls new blob: model.bin now has abc123 content ✓
```

See [Conflict Detection](#conflict-detection-and-resolution) for full algorithm.

#### Committed Ref Without Pushed Blob

**Scenario:** User commits `.yref` but forgets `blobsy push`. Other users pull and see
“missing (no remote!)”.

**Prevention (primary):** Pre-commit hook auto-pushes blobs when committing .yref files.

**Detection (secondary):** `blobsy check-unpushed` finds these cases.

**Resolution:** Original user runs `blobsy push` to upload the missing blob.

**Error message:**
```
✗ data/model.bin: Cannot pull (no remote blob)

Last commit:
  author: Alice <alice@example.com>
  date:   2026-02-20 14:03:22

Ask Alice to run: blobsy push data/model.bin
```

#### Pushed Blob Without Committed Ref

**Scenario:** User runs `blobsy push` but doesn’t `git commit` the updated `.yref`.
Other users have no way to know the data changed.

**Detection:** `blobsy status` on the pusher’s machine shows “up-to-date” (local matches
ref). The problem is invisible to the pusher - it only manifests when other users don’t
see the update.

**Resolution:** Commit the ref file.

**This is the most common mistake.** Always commit after push.

#### File Modified After `blobsy track`, Before Commit

**Scenario:**
```bash
$ blobsy track model.bin         # .yref hash = abc123
$ echo "more" >> model.bin       # File hash now = def456
$ git commit                     # Pre-commit hook runs blobsy push
```

**Pre-commit hook sanity check catches this:**
```
Error: Hash mismatch in model.bin
  Expected (in .yref): abc123
  Actual (file):       def456

File was modified after tracking.
Run 'blobsy track model.bin' to update the .yref.

Commit BLOCKED.
```

**Resolution:** Re-run `blobsy track` to update the .yref with the new hash.
````

**Consistency check:** ✅ Expands existing subsection with more detail.

---

### 5. Implementation Checklist

**Current:** No checklist for conflict detection features.

**Integration needed:** Add to V1 Scope or create new "V1 Implementation Checklist" section.

**Location:** After "V1 Scope" section (around line 3054)

**New content:**
```markdown
## V1 Implementation Checklist: Conflict Detection

### Pre-Commit Hook
- [ ] Hook script template (`.git/hooks/pre-commit`)
- [ ] `blobsy init` installs hook
- [ ] `blobsy hooks install/uninstall` commands
- [ ] `blobsy doctor` checks hook status
- [ ] Documentation on hook behavior
- [ ] Escape hatch: `git commit --no-verify`

### Sanity Checks in `blobsy push`
- [ ] Verify .yref hash matches file content
- [ ] Error with helpful message if mismatch
- [ ] `--force` flag to override (updates .yref to match file)
- [ ] Prevent corrupted/stale .yref files from being pushed

### Stat Cache as Merge Base
- [ ] Elevate from optional to mandatory for correctness
- [ ] Nanosecond mtime precision (`mtimeNs` as string for BigInt)
- [ ] Atomic cache updates (update atomically with file operations)
- [ ] Three-way merge algorithm implementation
- [ ] Conflict detection and clear error messages

### Attribution Commands
- [ ] `blobsy check-unpushed` - find committed .yref without blobs
- [ ] `blobsy pre-push-check` - CI-friendly verification
- [ ] Git blame integration in error messages (`getLastCommitInfo()`)
- [ ] Clear troubleshooting guidance in all errors

### Testing
- [ ] Test: git pull with stale local file (race condition)
- [ ] Test: local edit with unchanged .yref
- [ ] Test: three-way conflict (both changed)
- [ ] Test: hook prevents bad commits
- [ ] Test: hook can be skipped with --no-verify
- [ ] Test: multiple users concurrent edits
- [ ] Test: file modified after track, before commit (hook catches it)
- [ ] Test: stat cache missing/corrupted (auto-rebuild)

### Documentation
- [ ] "Conflict Detection and Resolution" section in main design
- [ ] Troubleshooting guide for conflict scenarios
- [ ] Recommended workflow (track → push → commit)
- [ ] Hook installation and behavior
- [ ] Examples of conflict resolution with three-way merge
````

**Consistency check:** ✅ New section, no conflicts.

* * *

## Consistency Analysis

### Potential Inconsistencies

#### 1. Stat Cache Role - RESOLVED

**Main design originally said:** Optional performance optimization.

**Conflict detection says:** Mandatory for correctness (merge base).

**Resolution:** Integration updates main design to say **both** - optional for read-only
ops, mandatory for write ops.
This is consistent.

#### 2. `blobsy sync` Behavior - CONSISTENT

**Main design says:** Push missing + pull missing.

**Conflict detection says:** Three-way merge determines which files are “missing” (local
modified → push, .yref updated → pull).

**Analysis:** These are consistent.
The three-way merge is the IMPLEMENTATION of how sync determines “local changed” vs
“.yref changed”.

#### 3. Pull Behavior on Modified Files - CONSISTENT

**Main design says (line 1281):** Pull fails with exit code 2 if file modified, unless
`--force`.

**Conflict detection says:** Three-way merge detects conflicts when both changed.

**Analysis:** Consistent.
The three-way merge catches “both changed” case and errors, which matches “pull fails on
modified files”.

#### 4. Pre-Commit Hook vs `blobsy init` - NEW BEHAVIOR

**Main design originally said:** `blobsy init` creates config file, prompts for backend.

**Conflict detection adds:** `blobsy init` also installs pre-commit hook.

**Consistency:** This is an ADDITION, not a contradiction.
Integration updates `blobsy init` section to mention hook installation.

#### 5. Command Additions - NEW COMMANDS

**Main design command list:** Does not include `blobsy hooks`, `blobsy check-unpushed`,
`blobsy pre-push-check`.

**Conflict detection adds these commands.**

**Consistency:** This is an ADDITION. Integration updates command summary.

#### 6. Exit Codes - CONSISTENT

**Main design says (line 1528):**
```
0   Success
1   Error (network, permissions, configuration)
2   Conflict (local file modified but ref not updated; pull refused)
```

**Conflict detection says:** Conflicts detected via three-way merge, errors raised.

**Analysis:** Consistent.
Exit code 2 for conflicts is already documented.

### Critical Decisions Needed

#### Decision 1: Stat Cache Mandatory or Optional?

**Conflict detection doc position:** Mandatory for correctness.

**Main design doc position (before integration):** Optional for performance.

**Proposed resolution:**
- **Mandatory** for operations that modify .yref files (`track`, `push`, `sync`)
- **Optional** for read-only operations (`status`, `verify`)
- **Auto-rebuild** if missing (hash all files, warn it’s slow)

**Is this consistent?** ✅ Yes, if we update the main design to clarify this distinction.

#### Decision 2: What if Hook Not Installed?

**Scenario:** User runs `blobsy init`, then deletes the hook (or uses an old clone
without re-running init).

**Conflict detection doc says:** Hook is “recommended” but skippable.

**Question:** Should `blobsy doctor` warn if hook is missing?

**Proposed answer:** Yes.
`blobsy doctor` should check:
```
Git hooks:
  ⚠ pre-commit hook not installed
    This hook prevents commits without pushed blobs.
    Install: blobsy hooks install
```

**Is this consistent?** ✅ Yes, adds clarity.

#### Decision 3: Stat Cache on Fresh Clone

**Scenario:** User clones repo.
No stat cache exists.
Runs `blobsy sync`.

**Conflict detection doc says (FAQ line 658):** “Conservative behavior: if local matches
.yref assume in sync; if differs warn and ask user.”

**Question:** Is this sufficient?

**Analysis:**
- On fresh clone, local files don’t exist yet (gitignored).
- So “local matches .yref” can’t happen.
- First `blobsy pull` or `blobsy sync` will pull everything.
- As files are pulled, stat cache is populated.

**Edge case:** User manually places files in repo (e.g., copied from backup), then
clones .yref files from git.
Now local files exist but no stat cache.
- If local hash == .yref hash → assume in sync, populate cache ✓
- If local hash != .yref hash → first-time case, assume local is truth (wrong!), would
  push wrong version ✗

**Better behavior:** On first run (no cache), if .yref has `remote_key` set and remote
blob exists, trust remote.
Pull if local differs.

**Proposed algorithm update:**
```typescript
// Case 2: First time (no cache entry)
if (!cached) {
  if (localHash === ref.hash) {
    // Local matches ref - in sync
    await updateStatCache(filePath, localHash);
    return;
  } else if (ref.remote_key) {
    // .yref has remote_key - pull from remote (trust git history)
    console.warn(`First sync: pulling ${filePath} from remote (local differs from ref)`);
    await pullBlob(filePath, ref.remote_key);
    await updateStatCache(filePath, ref.hash);
    return;
  } else {
    // No remote_key yet - assume local is truth (user just tracked this)
    console.log(`First sync: tracking ${filePath} (no remote yet)`);
    await updateRefAndPush(filePath, localHash);
    return;
  }
}
```

**Is this consistent?** ⚠️ **This is a refinement** of the conflict detection doc’s
algorithm. Should be integrated.

* * *

## Summary: Is Everything Consistent After Integration?

### YES, with these caveats:

1. ✅ **No contradictions** - Conflict detection content is an ADDITION to main design,
   not a replacement
2. ✅ **Stat cache role clarified** - Both performance AND correctness (mandatory for
   writes)
3. ✅ **Commands added** - `hooks`, `check-unpushed`, `pre-push-check`
4. ✅ **Hook installation added** to `blobsy init`
5. ⚠️ **Refinement needed** - First-time stat cache behavior (Decision 3 above)
6. ✅ **Testing expanded** - Conflict detection tests added to checklist

### Action Items

1. **Integrate** conflict detection content at the 5 locations identified above
2. **Update** “Case 2: First time” in three-way merge algorithm (Decision 3)
3. **Add** warning to `blobsy doctor` if hook not installed (Decision 2)
4. **Test** all conflict scenarios (race condition, three-way merge, hook blocking bad
   commits)
5. **Review** integrated document for flow and readability
6. **Archive** `conflict-detection-and-resolution.md` with note: “Superseded by main
   design”

### Final Consistency Score

**9/10** - Highly consistent.
The one refinement (Decision 3) is a minor enhancement, not a breaking change.
