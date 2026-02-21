# Conflict Detection Review Findings

**Date:** 2026-02-20

**Reviewed:** `blobsy-design-v2.md` and `conflict-detection-and-resolution.md`

## Status: Conflict Detection Content NOT Subsumed

The main design doc does NOT fully incorporate the conflict detection strategies.
Critical content is missing.

## What’s Missing from Main Design

### 1. The Critical Race Condition (HIGH PRIORITY)

**Missing from main doc:**
- Detailed explanation of the git pull desync scenario
- User A pushes, User B pulls but local file stays stale
- `blobsy sync` incorrectly interprets stale file as user modification

**Current state in main doc:**
- “Push/Commit Coordination” corner case mentions committed ref without pushed blob
- Does NOT explain the reverse: git pull updates .yref but NOT the payload file

### 2. Three-Layer Defense Strategy (HIGH PRIORITY)

**Missing from main doc:**
1. **Layer 1: Prevention** - Pre-commit hook that auto-pushes before allowing commit
2. **Layer 2: Detection** - Stat cache-based three-way merge
3. **Layer 3: Attribution** - Error messages showing who committed without pushing

**Current state in main doc:**
- No pre-commit hook mentioned
- No three-way merge algorithm
- No attribution helpers

### 3. Stat Cache Architecture Elevation (CRITICAL)

**Conflict detection doc says:**
- Stat cache is **mandatory** for correctness (merge base for three-way conflict
  detection)

**Main design doc says:**
- Stat cache is **optional** for performance (fast-path to avoid re-hashing)

**This is a fundamental architectural difference that MUST be resolved.**

### 4. Pre-Commit Hook (HIGH PRIORITY)

**Missing from main doc:**
- Hook installation during `blobsy init`
- Hook behavior (auto-runs `blobsy push` when committing .yref files)
- Sanity checks that block commit if push fails
- `blobsy hooks install/uninstall` commands
- Escape hatch with `git commit --no-verify`

### 5. Sanity Checks in `blobsy push` (HIGH PRIORITY)

**Missing from main doc:**
- Hash mismatch detection (file content vs .yref hash)
- Detailed error message when file was modified after `blobsy track`
- `--force` flag to override and update .yref to match current file
- Prevention of corrupted/stale .yref files being pushed

### 6. Three-Way Merge Algorithm (HIGH PRIORITY)

**Missing from main doc:**
- Decision table: Local Hash | .yref Hash | Cache Hash → Action
- Detection of “git pull updated .yref” vs “user modified file”
- Conflict detection when both changed
- Automatic resolution when only one side changed

### 7. Stat Cache Correctness Requirements (MEDIUM PRIORITY)

**Missing from main doc:**
- Atomic cache updates (update cache atomically with file operations)
- Nanosecond mtime precision requirement
- Cache invalidation rules
- When to update cache (after track/push/pull, never in between)

### 8. Attribution Commands (MEDIUM PRIORITY)

**Missing from main doc:**
- `blobsy check-unpushed` - find committed .yref files with missing remote blobs
- `blobsy pre-push-check` - CI-friendly command to verify all blobs pushed
- Git blame integration in error messages (show who committed the .yref)

## Additional Conflict/Resolution Issues

Beyond what’s in the conflict detection doc, here are other issues to consider:

### 1. Git Merge Conflicts in .yref Files (LOW PRIORITY - COVERED)

**Status:** Briefly covered in main doc’s “Conflict Model” section and FAQ in conflict
detection doc.

**What’s missing:** More detailed examples of resolving .yref merge conflicts (pick a
side, manual merge if needed).

### 2. Backend/Template Configuration Divergence (MEDIUM PRIORITY)

**Scenario:** Two users have different `key_template` or `backend` configs (one local,
one committed).

**Problem:**
- Different templates → different remote keys for same content
- One user pushes to `timestamp-hash/path`, other expects `sha256/hash`
- Pull fails with “blob not found”

**Current coverage:** Main doc mentions template must be consistent (line 479) but
doesn’t detail what happens if violated.

**Needed:**
- Detection: `blobsy doctor` checks if .yref remote_key format matches current template
- Error message: “This .yref was pushed with a different key_template”
- Resolution: Re-push with current template, or fix config

### 3. Compression Configuration Divergence (HIGH PRIORITY)

**Scenario:** User A has `compress: always: ["*.json"]`, User B doesn’t.

**Problem:**
- User A uploads `data.json.zst` (compressed)
- User B tries to pull, expects uncompressed `data.json`
- OR: Both upload different blobs for same content (compressed vs uncompressed)

**Current coverage:** Main doc says compression config “must be in repo-level config”
(line 1563) but doesn’t enforce it.

**Needed:**
- **Enforcement:** Blobsy should detect if compression settings in user config differ
  from repo config
- **Warning:** “Your local compression config differs from .blobsy.yml.
  This will cause sync issues.”
- **Validation:** `blobsy doctor` checks for compression config divergence

### 4. Concurrent `blobsy sync` Race (MEDIUM PRIORITY)

**Scenario:** Same user, same machine, two terminal windows both run `blobsy sync`.

**Problem:**
- Both read .yref at same time
- Both hash local file
- Both try to update .yref and stat cache
- File corruption or inconsistent state?

**Current coverage:** Not mentioned.

**Needed:**
- **Lock file** or **atomic .yref updates** to prevent concurrent writes
- OR: Document that concurrent invocations are unsafe
- OR: Detect concurrent runs and warn/error

### 5. File Modified During Hash/Upload (LOW PRIORITY)

**Scenario:** User (or another process) modifies file while `blobsy push` is hashing or
uploading it.

**Problem:**
- Hash is computed: abc123
- Mid-upload, file changes
- Upload completes with wrong content
- .yref says abc123 but remote has def456’s content

**Current coverage:** Not mentioned.

**Needed:**
- **Stat-based detection:** After upload, re-stat file, compare mtime
- **If mtime changed during upload:** Error, re-hash, verify hash matches
- **Or:** Read-lock file during hash+upload (may not be portable)

### 6. Lost Stat Cache Recovery (LOW PRIORITY)

**Scenario:** Stat cache deleted, corrupted, or on new clone.

**Current coverage:** Conflict detection doc mentions fallback behavior (lines 658-666)
but vague.

**Needed:**
- **Rebuild command:** `blobsy verify --rebuild-cache` (mentioned in FAQ line 664)
- **Or:** Auto-rebuild on first sync (hash all files, populate cache)
- **Clear behavior:** What does sync do when cache is empty?
  (Conservative: warn user, ask intent)

### 7. Hook Installation Drift (LOW PRIORITY)

**Scenario:** Team has 5 developers.
3 have pre-commit hook installed, 2 don’t.

**Problem:**
- Inconsistent behavior: some commits auto-push, others don’t
- The 2 without hooks commit .yref without pushing
- Other users hit “missing (no remote!)” errors

**Current coverage:** Conflict detection doc mentions hook is “recommended” (line 212)
but not enforced.

**Needed:**
- **Team coordination:** Documentation on ensuring all team members install hook
- **Detection:** `blobsy doctor` could warn if hook not installed
- **CI check:** `blobsy check-unpushed` in CI to catch commits without pushed blobs

### 8. Ref File Format Version Upgrades (LOW PRIORITY)

**Scenario:** Blobsy v2.0 introduces `blobsy-yref/0.2` format with new fields.

**Problem:**
- Old blobsy (v1.x) can’t read v0.2 refs
- Mixed repo with v0.1 and v0.2 refs
- Compatibility matrix gets complex

**Current coverage:** Format versioning policy (line 515-517) handles this: reject on
major mismatch, warn on newer minor.

**Needed:**
- **Migration command:** `blobsy migrate-refs --to=0.2` to upgrade all refs
- **Gradual rollout:** Allow v0.1 and v0.2 to coexist during transition
- **Clear error:** “This .yref is format 0.2 but your blobsy version only supports 0.1.
  Upgrade blobsy.”

### 9. Branch Switches with Uncommitted Changes (MEDIUM PRIORITY)

**Scenario:**
```bash
# On branch A, modify tracked file but don't commit
$ echo "new" > model.bin
$ blobsy track model.bin          # .yref updated but not committed
$ git checkout branch-B           # Switches branch, .yref reverts to branch-B's version
# Now: model.bin has new content, .yref has branch-B's hash (mismatch)
```

**Problem:**
- Local file out of sync with .yref
- `blobsy status` shows “modified”
- User confusion: “I just ran `blobsy track`!”

**Current coverage:** Not mentioned.

**Needed:**
- **Detection:** After branch switch, if .yref changed in working tree, warn user
- **OR:** Git hook (post-checkout) that runs `blobsy status` and warns if mismatches
  detected
- **Documentation:** Explain that uncommitted .yref changes are lost on branch switch
  (standard git behavior)

### 10. `.yref` File Manually Edited (LOW PRIORITY)

**Scenario:** User or tool (text editor, sed, etc.)
manually edits .yref file and corrupts it.

**Current coverage:** Corner cases section (line 2781-2785) mentions `blobsy verify`
detects this.

**Needed:**
- **Enhanced validation:** `blobsy doctor` checks all .yref files for:
  - Valid YAML syntax
  - Required fields present
  - Hash format valid (sha256:64-hex)
  - Size is positive integer
- **Auto-repair:** `blobsy track --fix` re-computes hash if file exists

### 11. Large .gitignore Files (LOW PRIORITY - NOT A BUG)

**Scenario:** 10,000 tracked files = 10,000 lines in .gitignore.

**Current coverage:** Main doc (line 2470-2473) says “this is fine”.

**Potential issue:** Git performance with huge .gitignore?

**Needed:**
- **Testing:** Verify git handles 10,000-line .gitignore efficiently
- **Alternative (V2):** Option to use single wildcard pattern (less precise but smaller
  .gitignore)

## Recommendation: Integration Plan

### Phase 1: Critical Architectural Alignment (BLOCKER for V1)

1. **Decide stat cache role:**
   - Is it **mandatory for correctness** (conflict detection doc)?
   - Or **optional for performance** (main design doc)?
   - **Recommendation:** Make it mandatory.
     Without it, the race condition is unsolvable.

2. **Document the race condition** in main design:
   - Add dedicated section: “## Conflict Detection and Resolution”
   - Explain git pull desync scenario
   - Explain why stat cache is needed as merge base

3. **Integrate three-layer defense:**
   - Document pre-commit hook installation
   - Document sanity checks in `blobsy push`
   - Document three-way merge algorithm

### Phase 2: CLI Commands (Required for V1)

1. Add to command summary:
   - `blobsy hooks install/uninstall`
   - `blobsy check-unpushed`
   - `blobsy pre-push-check` (for CI)

2. Document hook behavior in `blobsy init` section

3. Add `--force` flag documentation to `blobsy push`

### Phase 3: Additional Issues (V1 or V2)

Address issues #2-#11 above based on priority:
- **HIGH:** #3 (compression divergence), #4 (concurrent sync)
- **MEDIUM:** #2 (template divergence), #9 (branch switches)
- **LOW:** Rest can be deferred to V2 or documented as known limitations

### Phase 4: Consolidate or Archive

Once the main design doc fully incorporates conflict detection:
- Either **merge** conflict-detection-and-resolution.md into main design
- Or **archive** it with a note: “Superseded by Conflict Detection section in
  blobsy-design-v2.md”
- Do NOT leave both active without clear cross-references

## Open Question: Stat Cache - Mandatory or Optional?

**This is the CRITICAL decision needed before V1.**

**Option A: Mandatory (conflict detection doc’s position)**
- Pros:
  - Solves the race condition
  - Enables three-way merge
  - Clear correctness guarantees
- Cons:
  - Adds complexity (cache must always be correct)
  - What happens if cache is lost/corrupted?
    (requires rebuild or conservative fallback)
  - Cross-machine portability (cache is local, not synced)

**Option B: Optional (main design doc’s position)**
- Pros:
  - Simpler fallback (just hash everything)
  - Works on fresh clone without cache
- Cons:
  - **Cannot solve the race condition**
  - Users will hit “sync reverted my changes” bug
  - No three-way merge → can’t distinguish “git pull” from “user edit”

**Recommendation:**
- **Make stat cache mandatory** for operations that modify .yref files (`track`, `push`,
  `sync`)
- **Make it optional** for read-only operations (`status`, `verify`)
- **Auto-rebuild** cache if missing (hash all files, warn user it’s slow)
- **Validate** cache entries before trusting them (mtime+size check, fall back to hash
  if mismatch)

This gives correctness guarantees while maintaining graceful degradation.
