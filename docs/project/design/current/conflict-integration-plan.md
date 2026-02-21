# Integration Plan: Conflict Detection → Main Design

**Date:** 2026-02-20

**Goal:** Methodically integrate `conflict-detection-and-resolution.md` into
`blobsy-design-v2.md` and verify consistency.

## Integration Points

### 1. Integrity Model Section (Lines 741-848)

**Status:** ✅ Completed.
Stat cache section in main design replaced with summary and cross-reference to
[stat-cache-design.md](stat-cache-design.md), which is now the authoritative source for
stat cache design (entry format, storage layout, API, three-way merge algorithm, cache
update rules, and recovery).

* * *

* * *

### 2. Conflict Model Section (Lines 2384-2436)

**Current:** Basic explanation of git conflicts on .yref files.

**Integration needed:** Replace with comprehensive conflict detection section.

**Location:** Lines 2384-2436 (replace entire section)

**New content:**
````markdown
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

**Status:** ✅ Completed.
Full design now in [stat-cache-design.md](stat-cache-design.md), including decision
table, per-file sync logic, and all conflict cases.

* * *
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
See [stat-cache-design.md](stat-cache-design.md) for full design.
- [ ] File-per-entry storage with atomic writes
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

**Resolution:** Mandatory for write ops, optional for read-only ops.
Full design in [stat-cache-design.md](stat-cache-design.md).

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

**RESOLVED.** See [stat-cache-design.md](stat-cache-design.md).
Mandatory for write ops, optional for reads, auto-rebuild when missing.

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

**RESOLVED.** See “Missing Cache / Recovery” section in
[stat-cache-design.md](stat-cache-design.md).
If local matches .yref, create cache entry.
If local differs and no cache, error with resolution guidance.

* * *

## Summary: Is Everything Consistent After Integration?

### YES, with these caveats:

1. ✅ **No contradictions** - Conflict detection content is an ADDITION to main design,
   not a replacement
2. ✅ **Stat cache role clarified** - Both performance AND correctness (mandatory for
   writes)
3. ✅ **Commands added** - `hooks`, `check-unpushed`, `pre-push-check`
4. ✅ **Hook installation added** to `blobsy init`
5. ✅ **Stat cache design consolidated** - See
   [stat-cache-design.md](stat-cache-design.md)
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
