# Feature: Design Documentation Consistency Fixes

**Date:** 2026-02-21

**Author:** AI Design Review

**Status:** Draft

## Overview

A comprehensive review of all design documentation and implementation specs identified
27 distinct issues ranging from critical contradictions to minor clarity improvements.
This spec catalogs all issues, organizes them by priority, and provides a systematic
approach for resolution before V1 release.

The review covered:
- 6 current design documents
- 4 active implementation specs
- 3 supporting research documents

Issues span critical contradictions (#1-3), design gaps (#4-8), clarity problems
(#9-14), implementation mismatches (#15-16), loose ends (#17-21), minor improvements
(#22-25), and newly discovered issues (#26-27).

## Goals

- Ensure design documentation is internally consistent across all files
- Eliminate contradictions between design docs and implementation specs
- Clarify ambiguous or underspecified sections before V1 release
- Document all deferred features systematically
- Improve documentation clarity for future contributors

## Non-Goals

- Implementing the fixes themselves (separate beads/work items)
- Redesigning features or changing architectural decisions
- Adding new features not already documented
- Rewriting documentation from scratch

## Background

As blobsy approaches V1 release, documentation consistency is critical for:
1. **Developer onboarding**: New contributors need clear, consistent guidance
2. **Implementation accuracy**: Specs must match design intent
3. **User experience**: Documented behavior must match implementation
4. **Maintenance**: Future changes need solid foundation

The review identified that while the design is fundamentally sound, there are specific
areas where:
- Multiple documents describe the same feature differently
- Design documents describe features not yet implemented
- Implementation specs defer features mentioned in design as “shipped”
- Terminology is used inconsistently

## Issue Catalog

### Critical Issues (P0) - Must Fix Before V1

#### Issue #1: Git Branch Sanitization Status Contradiction

**Affected files:**
- [blobsy-design.md:452](../../design/current/blobsy-design.md)
- [issues-history.md:101](../../design/current/issues-history.md)

**Problem:** The design states that branch name sanitization is “eliminated” by the
architectural shift to content-addressable storage.
However, the error handling section (lines 440-452 in blobsy-design.md) describes full
error handling for `{git_branch}` template variable, including sanitization logic via
`sanitizeKeyComponent()`. This is contradictory.

**Impact:** Developers and users are unclear whether branch-isolated mode exists in V1
or is deferred to Phase 2. Documentation creates confusion about what’s implemented vs.
deferred.

**Recommended fix:** Choose one approach:
- **Option A**: Fully remove all `{git_branch}` references from the main design if
  deferred to Phase 2
- **Option B**: Clarify that Phase 1 omits branch-isolated mode but the design is
  complete and ready for Phase 2 implementation

Add a clear “V1 Implementation Status” note in the template variables section.

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

At line 284, modify the template variable table:

```diff
 | `{dirname}` | Directory path only | `data/research/` |
-| `{git_branch}` (Deferred) | Current git branch | `main`, `feature/x` |
+| `{git_branch}` | Current git branch | `main`, `feature/x` | **[V2]** |
 | `{compress_suffix}` | Compression suffix based on algorithm | `.zst`, `.gz`, `.br`, or empty string |
```

Add immediately after the table (line 286):

```markdown
**V1 Implementation Status:**
- ✅ Implemented: `{iso_date_secs}`, `{content_sha256}`, `{content_sha256_short}`, `{repo_path}`, `{filename}`, `{dirname}`, `{compress_suffix}`
- ⏸️ Deferred to V2: `{git_branch}` (see implementation rationale in [issues-history.md](issues-history.md#L101))

The `{git_branch}` variable and branch-isolated storage mode are fully designed for V2 but not implemented in V1. If you specify a template containing `{git_branch}` in V1, `blobsy push` will issue a warning and leave the variable unexpanded (e.g., `{git_branch}/sha256/...` as a literal path).
```

At lines 440-459, wrap the entire error behavior section:

```diff
+**V2 Specification (Not Implemented in V1):**
+
 **Error behavior (V2 specification):**

 - **Detached HEAD:** If `{git_branch}` is used but...
```

At line 452, modify the sanitization note:

```diff
-- **Branch name sanitization:** The resolved branch name is passed through
-  `sanitizeKeyComponent()` to handle characters problematic for S3 keys (e.g.,
-  `feature/model-v2` becomes `feature/model-v2` -- forward slashes are preserved).
+- **Branch name sanitization:** The resolved branch name will be passed through
+  `sanitizeKeyComponent()` (implemented in `template.ts:25-39`) which handles characters
+  problematic for S3 keys. Forward slashes are **preserved** to create directory-like
+  structure (e.g., `feature/model-v2` → `feature/model-v2/sha256/...` in remote storage).
```

**File: `packages/blobsy/src/template.ts`**

Add a TODO comment at line 60 (after compress_suffix):

```typescript
  compressSuffix: vars.compressSuffix ?? '',
  // TODO(V2): Add git_branch variable resolution
  // gitBranch: await resolveGitBranch(),
};
```

* * *

#### Issue #2: Compression State and Remote Key Template Interaction Underspecified

**Affected files:**
- [blobsy-design.md:298-300](../../design/current/blobsy-design.md)
- [blobsy-design.md:636-646](../../design/current/blobsy-design.md)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md:113](plan-2026-02-21-blobsy-phase2-v1-completion.md)

**Problem:** The `.bref` format includes optional `compressed` and `compressed_size`
fields. However, the design states that compression suffix handling can work two ways:
1. Suffix in template variable (`{compress_suffix}`)
2. Automatic suffix handling by blobsy

But there’s no clear specification of:
- When each mode applies
- How they interact
- Whether both can coexist in the same repository
- What happens on push if remote key was generated with one mode but local config
  differs

**Impact:** Implementation risk: developers may make different assumptions about when to
use `{compress_suffix}` vs automatic handling.
Could lead to bugs where compression state and remote key are mismatched.

**Recommended fix:** Add explicit decision rules to the template evaluation section:
- Document that `{compress_suffix}` is explicit user control
- Document that automatic handling is when suffix not in template
- Show examples of both modes
- Specify that repos should use one mode consistently
- Add error/warning if switching modes mid-repository

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

After line 300, add new section:

```markdown
**Compression Suffix Handling:**

The `{compress_suffix}` variable is **automatically evaluated** based on the compression decision made by `shouldCompress()` (see `compress.ts:30-46`). The suffix is determined as follows:

1. **Compression Decision** (per file):
   - Check if file matches `compress.never` patterns → **No compression**, suffix = `''`
   - Check if file matches `compress.always` patterns → **Compress**, suffix based on algorithm
   - Check if file size ≥ `compress.min_size` → **Compress**, suffix based on algorithm
   - Otherwise → **No compression**, suffix = `''`

2. **Suffix Mapping** (see `template.ts:82-94`):
```
zstd → ‘.zst’ gzip → ‘.gz’ brotli → ‘.br’ no compression → ‘’
````

3. **Template Evaluation**:
- If your template includes `{compress_suffix}`, it expands to the suffix (or empty string)
- If your template omits `{compress_suffix}`, compressed and uncompressed versions **will collide** on the same remote key

**Best Practice:** Always include `{compress_suffix}` in custom templates to prevent collisions.

**Default Behavior:**
The default template (`'{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}'`) includes the suffix, so users don't need to think about this unless they customize `remote.key_template`.

**Example Collision Scenario:**
```yaml
# ❌ BAD: Custom template without compress_suffix
remote:
key_template: '{content_sha256}/{repo_path}'

# Result: compressed and uncompressed versions collide
# - First push (uncompressed): key = sha256-abc123.../data/model.bin
# - Second push (now compressed): key = sha256-abc123.../data/model.bin ← Same key!
````

```yaml
# ✅ GOOD: Include compress_suffix
remote:
  key_template: '{content_sha256}/{repo_path}{compress_suffix}'

# Result: compressed and uncompressed versions have different keys
# - Uncompressed: sha256-abc123.../data/model.bin
# - Compressed: sha256-abc123.../data/model.bin.zst ← Different key
```

**Compression State Storage:** The actual compression algorithm and compressed size are
stored in the `.bref` file (fields `compressed` and `compressed_size`). The remote key
suffix is only a convenience for human readability.
````

---

#### Issue #3: Working Tree vs HEAD Semantics Incomplete for Sync

**Affected files:**
- [blobsy-design.md:768-780](../../design/current/blobsy-design.md) (Working tree vs
  HEAD semantics table)
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md)
  (entire file)

**Problem:** The working tree vs HEAD semantics table says `blobsy sync` reads from
"Working tree" and "can operate on uncommitted refs: Yes (with warning)". However, the
stat cache design's three-way merge algorithm (lines 320-395) has an "ambiguous" case
that errors when no merge base exists.
This creates an ambiguity:
- What warning is shown for uncommitted refs on sync?
- Can sync proceed with uncommitted refs if they're unambiguous?
- Does the "ambiguous" error subsume the uncommitted ref warning?
- What's the precedence between the warning and error?

**Impact:** UX confusion and potential bugs if sync behavior differs from documentation.
Users won't know when they can safely sync uncommitted changes.

**Recommended fix:** Clarify the sync behavior with uncommitted refs:
1. Document that the uncommitted ref warning is shown first
2. Specify that sync proceeds if stat cache state is unambiguous
3. Show example output with both warning and ambiguous error
4. Add decision tree: check working tree → warn if uncommitted → check stat cache →
   error if ambiguous

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

After line 780, add new section:

```markdown
**Uncommitted .bref Handling Details:**

When `blobsy sync` encounters uncommitted `.bref` files, the behavior follows this decision flow:

1. **Check working tree state** → Compare working tree `.bref` to `HEAD:.bref`
2. **Issue warning** if uncommitted refs detected:
````
Warning: 2 .bref files have uncommitted changes.
Run ‘git add -A && git commit’ to commit them.
```
3. **Proceed to stat cache merge** → Use three-way merge algorithm (see [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md#three-way-merge-algorithm))
4. **Error if ambiguous** → No merge base exists (see line 356-368 of stat-cache-design.md):
```
Error: No stat cache entry for data/model.bin.
Cannot distinguish local edit from git pull.
Use ‘blobsy push’ or ‘blobsy pull’ explicitly.
````

**Precedence:** Warning is shown first, but ambiguous state can still cause error. Sync proceeds only if stat cache state is **unambiguous**.

**Example: Uncommitted + Ambiguous**
```bash
$ blobsy sync
Warning: 1 .bref file has uncommitted changes. Run 'git add -A && git commit' to commit.

Syncing 1 file...
✗ Error: No stat cache entry for data/model.bin.
Cannot distinguish local edit from git pull.
Use 'blobsy push' or 'blobsy pull' explicitly.
````

**Recovery Flow:**
1. User runs `blobsy status` to see current state
2. User decides: `blobsy push` (if local changes intended) or `blobsy pull` (if git pull
   updated ref)
3. After explicit push/pull, stat cache is updated with merge base
4. Future `blobsy sync` will work without ambiguity
````

**File: `docs/project/design/current/blobsy-stat-cache-design.md`**

At line 334 (in the decision table), add a note column:

```diff
 | B | A | (none) | Ambiguous -- no merge base | **Error** (ask user) |
+
+**Note on uncommitted refs:** The "ambiguous" case often occurs after `git pull` when the user hasn't run `blobsy` commands yet. The working tree `.bref` differs from the file on disk, but there's no stat cache entry to determine which changed first. Solution: run explicit `blobsy push` or `blobsy pull` to establish merge base.
````

* * *

### Design Gaps (P1) - Need Specification Before V1.1

#### Issue #4: Stat Cache Stale Mtime Risk Not Addressed

**Affected files:**
- [blobsy-stat-cache-design.md:262-266](../../design/current/blobsy-stat-cache-design.md)

**Problem:** The design states “Without the merge base, the two cases are
indistinguishable” for local file modification vs.
git-updated ref. But it also says “size + mtime” is the comparison key, and mtime is not
reliable after `git checkout` or file copying.

The design correctly notes that mtime is per-machine and `git checkout` resets it, but
doesn’t specify:
- What happens if user runs `blobsy sync` immediately after `git checkout` with mtime
  reset but content unchanged?
- Does stat cache have an escape hatch for this case?
- Should `blobsy status` warn about this?

**Impact:** Users doing branch switches or cherry-picks may see false positives (files
appearing modified when they’re not).
May lead to unnecessary re-uploads or confusing “ambiguous state” errors.

**Recommended fix:** Document the recovery flow:
- If a user gets ambiguous state after git operations, they can use
  `blobsy verify --rebuild-cache` to resolve it
- Add a note in the stat cache design about the mtime limitation
- Consider adding `--rebuild-cache` flag to `blobsy sync` for post-checkout recovery

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-stat-cache-design.md`**

After line 266, add new section:

````markdown
### Mtime Reset Recovery

**Problem:** After `git checkout`, `git cherry-pick`, or file copying, mtime changes even if content is identical. This can cause stat cache misses and false "ambiguous state" errors.

**Example Scenario:**
```bash
git checkout feature-branch  # All files get new mtime (current time)
blobsy sync                  # May report "ambiguous state" because mtime differs from cache
````

**Recovery Flows:**

1. **Automatic (on hash recompute):**
   - If stat cache miss occurs (mtime differs), blobsy recomputes hash (line 293-299 in
     stat-cache-design.md)
   - If hash matches cached hash, cache entry is updated with new mtime
   - No user action needed for single-file operations

2. **Manual (post-checkout):**
   - User can run `blobsy verify --rebuild-cache` to revalidate all files and update
     cache entries
   - This hashes every tracked file and updates stat cache with current mtime
   - Useful after bulk operations like `git checkout`, `git rebase`, or rsync

3. **Escape Hatch (explicit commands):**
   - If `blobsy sync` reports “ambiguous state”, user runs explicit `blobsy push` or
     `blobsy pull`
   - This establishes a new merge base in the stat cache
   - Future syncs will work normally

**Implementation Note:**

The `verify` command already supports `--rebuild-cache` flag (though not heavily
advertised). Add to CLI help text:

```
blobsy verify [options] [paths...]

Options:
  --rebuild-cache    Rebuild stat cache entries for all verified files
                     (useful after git checkout or branch switches)
```

**Risk Mitigation:**

This limitation is **rare in practice** because:
- Most workflows involve either local edits OR git operations, not interleaved
- Hash recomputation is fast for most files (< 100ms per file on modern hardware)
- Users can explicitly push/pull to resolve ambiguity
````

---

#### Issue #5: Multi-User Push Collision Handling Underspecified

**Affected files:**
- [blobsy-design.md:360-391](../../design/current/blobsy-design.md) (CAS mode)
- [blobsy-design.md:465-506](../../design/current/blobsy-design.md) (Shared mode)
- [blobsy-design.md:509-518](../../design/current/blobsy-design.md) (Comparison table)

**Problem:** Pure content-addressable storage prevents collisions because same content =
same hash = same key.
Global shared storage uses "last-write-wins" semantics with explicit warning.
But what about the **default template** (timestamp + hash)?

- If two users push identical content to the same path **within the same second**, they
  produce identical keys (per line 296: "Same path+content+timestamp = deduplicates")
- What happens if they push slightly different content at the same timestamp?
- The comparison table says timestamp+hash has "Same path+content+timestamp" dedup, but
  this is vague about collisions

**Impact:** Potential data loss if concurrent pushes aren't handled correctly.
Documentation doesn't clearly state collision behavior.

**Recommended fix:** Document timestamp granularity and collision behavior:
- Specify timestamp format (ISO 8601 with second/millisecond precision)
- State that "Within the same second, identical content deduplicates; different content
  produces different keys by hash"
- Add example showing two pushes at same timestamp with different content
- Clarify that hash prevents collisions even at same timestamp

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

At line 295, expand the timestamp note:

```diff
-**Note on `{iso_date_secs}`:** Format is `YYYYMMDDTHHMMSSZ` (e.g., `20260220T140322Z`).
-All punctuation removed for cleaner keys.
-Second resolution allows deduplication of identical content pushed in the same second to
-the same path (all three must match: timestamp, content hash, and path).
+**Note on `{iso_date_secs}`:** Format is `YYYYMMDDTHHMMSSZ` (e.g., `20260220T140322Z`).
+All punctuation removed for cleaner keys. Granularity is **1 second** (no sub-second precision).
+
+**Deduplication and Collision Behavior:**
+
+Same path + content + timestamp → **Deduplicates** (produces identical key)
+- Example: Two users push identical `data/model.bin` at `20260220T140322Z`
+- Key: `20260220T140322Z-7a3f0e9b2c1d/data/model.bin.zst` (both users)
+- Result: Last write wins (S3 overwrites), but content is identical so no data loss
+
+Same path + **different content** + same timestamp → **Different keys** (hash differs)
+- Example: User A pushes `model_v1.bin`, User B pushes `model_v2.bin` at same second
+- Key A: `20260220T140322Z-abc12345.../data/model.bin`
+- Key B: `20260220T140322Z-def67890.../data/model.bin`
+- Result: No collision, both versions stored
+
+**Multi-User Safety:**
+
+The default template provides collision safety even at second granularity because:
+1. Content hash is part of the key → different content = different key
+2. Identical content pushes deduplicate safely (overwriting identical blob is harmless)
+3. Path is part of key → different paths never collide
+
+**Timestamp Format Implementation:** See `template.ts:38-40` for `formatIsoDateSecs()`.
````

* * *

#### Issue #6: `blobsy mv` Move Semantics Incomplete

**Affected files:**
- [blobsy-design.md:1240-1305](../../design/current/blobsy-design.md) (Move semantics)
- [plan-2026-02-21-blobsy-phase1-implementation.md:76, 171](plan-2026-02-21-blobsy-phase1-implementation.md)

**Problem:** The design includes a full error scenario (lines 1290-1305) showing what
happens if `.bref` points to the wrong file after a manual `mv` command.
However, the spec says `blobsy mv` is for files only and directory support is deferred.
But it doesn’t specify:
- Can you move a tracked file to a different directory and maintain `.bref` +
  `.gitignore` coherence?
- What if the destination directory has different externalization rules?
- Does `.gitignore` remain in the source directory referencing a deleted file?

**Impact:** Incomplete feature specification may lead to inconsistent `.gitignore`
state. Users may end up with orphaned gitignore entries.

**Recommended fix:** Add explicit examples of directory-spanning moves:
- Show `blobsy mv data/old/file.dat research/new/file.dat`
- Document that `.gitignore` is updated in both source and destination directories
- Specify cleanup behavior for source directory `.gitignore`
- Note if externalization rules are re-evaluated at destination

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

At line 1305 (after the error scenario), add new section:

````markdown
### Directory-Spanning Moves

**Scenario:** Moving a tracked file from one directory to another.

**Example:**
```bash
blobsy mv data/old/model.bin research/experiments/model.bin
````

**Operation Sequence:**

1. **Validation:**
   - Check source file exists and is tracked (has `.bref`)
   - Check destination directory exists (create if `--mkdir` flag provided, error
     otherwise)
   - Check destination file doesn’t exist (error if exists, unless `--force`)

2. **Externalization Re-Evaluation:**
   - Read `.blobsy.yml` from destination directory context
   - Check if file still matches externalization rules in new location
   - **If destination has different externalization config**, issue warning:
     ```
     Warning: Destination directory has different externalization rules.
     File will remain externalized per source rules. Re-track with 'blobsy track' to re-evaluate.
     ```

3. **Move Operations:**
   - Move payload file: `data/old/model.bin` → `research/experiments/model.bin`
   - Move `.bref` file: `data/old/model.bin.bref` →
     `research/experiments/model.bin.bref`
   - Update `.bref` remote_key is **NOT changed** (remote blob stays at same key)

4. **Gitignore Updates:**
   - **Source directory** (`data/old/.gitignore`):
     - Remove `model.bin` entry from blobsy-managed block
     - If block becomes empty, remove the entire block
     - If `.gitignore` becomes empty, delete the file
   - **Destination directory** (`research/experiments/.gitignore`):
     - Add `model.bin` entry to blobsy-managed block
     - Create block if it doesn’t exist
     - Create `.gitignore` if it doesn’t exist

5. **Git Staging:**
   - Stage all modified files: payload, `.bref`, source `.gitignore`, dest `.gitignore`
   - User must commit the move

**Example Output:**
```bash
$ blobsy mv data/old/model.bin research/experiments/model.bin

✓ Moved data/old/model.bin → research/experiments/model.bin
✓ Moved data/old/model.bin.bref → research/experiments/model.bin.bref
✓ Updated .gitignore (2 files)

Staged files:
  research/experiments/model.bin
  research/experiments/model.bin.bref
  research/experiments/.gitignore
  data/old/.gitignore

Run 'git commit' to complete the move.
```

**Edge Case: Source .gitignore Cleanup**

If the moved file was the last entry in the source directory’s blobsy-managed block:

```gitignore
# Before move (data/old/.gitignore)
# blobsy -- DO NOT EDIT BELOW THIS LINE
model.bin
# blobsy -- DO NOT EDIT ABOVE THIS LINE

other-pattern.txt
```

```gitignore
# After move (data/old/.gitignore) -- blobsy block removed
other-pattern.txt
```

If the file becomes empty, it’s deleted.
````

---

#### Issue #7: Externalization Rules Interaction with Directory Tracking Unclear

**Affected files:**
- [blobsy-design.md:254-258](../../design/current/blobsy-design.md) (Externalization
  rules)
- [plan-2026-02-21-blobsy-phase1-implementation.md:465-481](plan-2026-02-21-blobsy-phase1-implementation.md)

**Problem:** When you run `blobsy track data/research/`, the design says it applies
externalization rules per-file.
But the externalization rules depend on file path, size, and patterns from
`.blobsy.yml`. What happens if:
- Subdirectory config has different `never` patterns than parent?
- A file matches both `never` and `always` patterns (rule precedence)?
- Config is updated between `track` runs on the same directory?

**Impact:** May lead to inconsistent externalization decisions.
Users won't understand why some files in a directory are externalized and others aren't.

**Recommended fix:** Add explicit precedence rules:
1. `never` patterns take precedence over `always`
2. More specific path patterns take precedence over general patterns
3. Subdirectory configs replace parent patterns (not append)
4. Document what "replacement" means for pattern arrays

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

After line 258, add new section:

```markdown
### Externalization Rule Precedence

When multiple rules could apply to a file, blobsy uses the following precedence order:

**Priority Order:**

1. **`externalize.never` patterns** (highest priority)
   - If file matches any `never` pattern → **NOT externalized** (even if matches `always`)
   - Example: `*.md` in never list → README.md not externalized

2. **`externalize.always` patterns**
   - If file matches any `always` pattern (and no `never` pattern) → **Externalized**
   - Example: `*.parquet` in always list → data.parquet externalized

3. **`externalize.min_size` threshold** (lowest priority)
   - If file size ≥ min_size (and no pattern match) → **Externalized**
   - Example: 5MB file with min_size=1mb → externalized

**Implementation Reference:** `packages/blobsy/src/compress.ts:30-46` (same logic applies to compression)

**Pattern Matching:**

- Uses glob-style matching via `micromatch`
- Patterns match against **repository-relative paths** (forward slashes, even on Windows)
- Examples:
  - `*.pkl` matches `model.pkl` and `data/weights.pkl`
  - `data/**/*.bin` matches only `.bin` files under `data/` directory

**Subdirectory Config Behavior:**

Config files in subdirectories **replace** parent patterns (not append):

```yaml
# Root .blobsy.yml
externalize:
  always: ["*.parquet", "*.bin"]
  never: ["*.md"]

# data/experiments/.blobsy.yml
externalize:
  always: ["*.pkl"]  # Replaces root 'always' list
  never: []          # Replaces root 'never' list (empty = nothing ignored)
````

Result:
- `data/model.bin` → Uses root config → **Externalized** (matches *.bin in always)
- `data/experiments/weights.pkl` → Uses subdir config → **Externalized** (matches *.pkl
  in always)
- `data/experiments/model.bin` → Uses subdir config → **NOT externalized** (subdir
  config replaced *.bin)

**Best Practice:** Keep externalization rules in root `.blobsy.yml` to avoid confusion.
Use subdirectory configs only when absolutely necessary.
````

---

#### Issue #8: Health Check Interaction with Command Backends Deferred but Not Specified

**Affected files:**
- [blobsy-backend-and-transport-design.md:814-927](../../design/current/blobsy-backend-and-transport-design.md)
  (Command backends)
- [blobsy-backend-and-transport-design.md:925-926](../../design/current/blobsy-backend-and-transport-design.md)
  (Health check skip note)

**Problem:** The design explicitly says command backends skip health checks (lines
925-926) because "arbitrary commands may lack a safe, side-effect-free health check."
However, this creates an inconsistent user experience:
- User runs `blobsy push` with command backend; no health check runs
- User runs `blobsy push` with S3 backend; health check runs
- Which backends should the user trust more?

**Impact:** Users with custom command backends can't validate backend health before bulk
transfers. May lead to partial failures mid-transfer.

**Recommended fix:** Either:
- **Option A**: Document that command backends must be pre-tested by users
- **Option B**: Allow users to specify an optional health command in the command backend
  config (e.g., `health_check_cmd: "test -w $REMOTE_DIR"`)

Add explicit note in command backend section about health check limitations.

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-backend-and-transport-design.md`**

At line 820 (command backend health check row), expand:

```diff
-| `command` | Deferred (arbitrary commands may lack a safe, side-effect-free health check) | -- |
+| `command` | None (arbitrary commands may lack a safe, side-effect-free health check) | User must test command manually before bulk operations |
````

After line 843, add new section:

````markdown
### Command Backend Health Check Guidance

Since command backends don't have automatic health checks, users should test them manually before relying on them for production workflows.

**Testing Procedure:**

1. **Test push with small file:**
   ```bash
   # Track and push a small test file
   echo "test" > test.txt
   blobsy track test.txt
   blobsy push test.txt
````

2. **Verify remote storage:**
   - Check that the remote command actually stored the blob
   - For `command` backends, inspect `$REMOTE_STORAGE_DIR` or run your get command
     manually

3. **Test pull:**
   ```bash
   # Delete local payload and restore
   rm test.txt
   blobsy pull test.txt
   cat test.txt  # Should output "test"
   ```

4. **Test error handling:**
   - Temporarily break the command (e.g., wrong credentials, bad path)
   - Verify that blobsy shows clear error messages

**Optional: User-Defined Health Command (V1.1)**

In V1.1, command backends could support an optional `health_check_command` field:

```yaml
backend:
  url: command://
  command_push: "./custom-upload.sh ${LOCAL_FILE} ${REMOTE_KEY}"
  command_pull: "./custom-download.sh ${REMOTE_KEY} ${LOCAL_FILE}"
  health_check_command: "test -d ${REMOTE_STORAGE_DIR} && test -w ${REMOTE_STORAGE_DIR}"
```

This is deferred to V1.1 pending user feedback on whether it’s needed.
````

---

* * *

### Clarity Issues (P1-P2) - Confusing Documentation

#### Issue #9: "Atomic Writes" Terminology Inconsistent

**Affected files:**
- [blobsy-backend-and-transport-design.md:536-570](../../design/current/blobsy-backend-and-transport-design.md)

**Problem:** The section titled "Atomic Writes" actually covers atomic **downloads**,
not uploads. The section conflates push and pull:
- Title says "Atomic Writes" (implies push)
- Content covers download pattern (pull)
- No mention of atomic writes for `.bref` updates (which is actually covered elsewhere
  in temp-file-then-rename)

**Impact:** Confusing for readers and potential implementation gaps.
Developers may not understand which operations are atomic.

**Recommended fix:**
- Retitle section as "Atomic Writes and Downloads"
- Split into two subsections: "Atomic .bref Updates" and "Atomic Downloads"
- Cross-reference the temp-file-then-rename pattern for `.bref` updates
- Clarify that atomicity applies to: `.bref` updates (push), remote blob writes (push),
  and local blob downloads (pull)

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-backend-and-transport-design.md`**

At line 536, retitle and restructure:

```diff
-## Atomic Writes
+## Atomic Operations

-**All backends:** Blobsy manages atomic downloads for ALL backends to ensure consistent,
-reliable behavior regardless of the underlying transport mechanism.
-We do not rely on external tools to handle atomicity.
+Blobsy ensures atomicity for all file operations (both reads and writes) to prevent corruption and inconsistent state.

+### Atomic .bref Updates (Push)
+
+When `blobsy push` updates a `.bref` file, it uses **temp-file-then-rename** pattern:
+
+1. Compute new `.bref` content (hash, size, remote_key, compressed fields)
+2. Write to temporary file `.bref.tmp-{random}`
+3. `fsync()` to ensure data reaches disk
+4. Atomically rename `.bref.tmp-{random}` → `.bref`
+
+**Atomicity guarantee:** The `.bref` file is never in a partially-written state. Either the old version exists, or the new version exists — no intermediate state.
+
+**Implementation:** `packages/blobsy/src/ref.ts:67-81` (uses `atomically` package)
+
+### Atomic Remote Blob Writes (Push)
+
+For S3 backends, blob uploads are atomic because S3 `PutObject` is atomic:
+- Object appears at key only after complete upload
+- Failed uploads leave no partial object
+- No temp file needed (S3 handles atomicity)
+
+For local backends, same temp-file-then-rename pattern as .bref files:
+1. Write to `.blobsy/store/{key}.tmp-{random}`
+2. `fsync()` to disk
+3. Rename to `.blobsy/store/{key}`
+
+### Atomic Downloads (Pull)

+**All backends:** Blobsy manages atomic downloads for ALL backends to ensure consistent,
+reliable behavior regardless of the underlying transport mechanism.
+We do not rely on external tools to handle atomicity.

+**Download pattern:**
````

* * *

#### Issue #10: `{git_branch}` Variable Format Underspecified

**Affected files:**
- [blobsy-design.md:284](../../design/current/blobsy-design.md) (Template variable
  table)
- [blobsy-design.md:408-409](../../design/current/blobsy-design.md) (Example values)
- [blobsy-design.md:452](../../design/current/blobsy-design.md) (Sanitization mention)

**Problem:** The template variable table lists `{git_branch}` (deferred) with example
`main`, `feature/x`. The error handling section (line 452) mentions forward slashes are
preserved. But this contradicts the sanitization function `sanitizeKeyComponent()`
mentioned in the same section.
- Are forward slashes allowed in the final key, or are they sanitized away?
- If they’re preserved, how do they interact with S3 path structure?

**Impact:** Confusing for users who want to implement branch-isolated mode in future
versions.

**Recommended fix:** Clarify that forward slashes in branch names are preserved in the
key, creating directory-like structure in remote storage (e.g.,
`feature/experiment/sha256/...`). Add example showing branch `feature/dark-mode`
resulting in remote key like `feature/dark-mode/2026-02-21T10:30:00Z/sha256-abc123...`

**Detailed Line-Level Solution:**

Covered in Issue #1 solution above (lines 440-452 modification).

* * *

#### Issue #11: Compression Minimum Size Units Ambiguous

**Affected files:**
- [plan-2026-02-21-blobsy-phase1-implementation.md:328-329](plan-2026-02-21-blobsy-phase1-implementation.md)

**Problem:** Defaults include `"externalize.min_size": "1mb"` and
`"compress.min_size": "100kb"`. The format is a string with unit suffix.
However:
- What units are supported?
  MB, mb, MiB, etc.?
- Is parsing case-sensitive?
- What happens if you use invalid units?

**Impact:** Configuration errors in `.blobsy.yml` may fail silently or with unclear
messages.

**Recommended fix:** Document supported units explicitly:
- List: `B`, `KB`, `MB`, `GB` (and lowercase equivalents)
- Specify that parsing is case-insensitive
- Add validation with clear error messages for invalid units
- Show example error:
  `Invalid size format "1megabyte". Use format like "1mb" or "100kb".`

**Detailed Line-Level Solution:**

**File: `docs/project/specs/active/plan-2026-02-21-blobsy-phase1-implementation.md`**

After line 329, add:

````markdown
**Size Format Specification:**

The size format for `min_size` settings follows the pattern: `<number><unit>`

**Supported Units** (case-insensitive, 1024-based):
- `b` or `B` → 1 byte
- `kb` or `KB` → 1,024 bytes
- `mb` or `MB` → 1,048,576 bytes (1024²)
- `gb` or `GB` → 1,073,741,824 bytes (1024³)
- `tb` or `TB` → 1,099,511,627,776 bytes (1024⁴)

**Features:**
- Case-insensitive: `"1MB"` = `"1mb"` = `"1Mb"`
- Decimal values supported: `"1.5mb"` → 1,572,864 bytes
- Whitespace allowed: `"100 kb"` (optional space between number and unit)

**Examples:**
```yaml
externalize:
  min_size: "1mb"      # 1,048,576 bytes
  min_size: "100kb"    # 102,400 bytes
  min_size: "1.5gb"    # 1,610,612,736 bytes
  min_size: "500 MB"   # 524,288,000 bytes (with space)
````

**Error Handling:**

Invalid formats produce clear error messages:

```bash
# Invalid unit
$ blobsy init local://storage --min-size=1megabyte
Error: Invalid size format: "1megabyte"
Expected format: <number><unit> (e.g., "1mb", "100kb")
Supported units: b, kb, mb, gb, tb

# Invalid number
$ blobsy track --min-size=abc
Error: Invalid size format: "abc"
Expected format: <number><unit> (e.g., "1mb", "100kb")
```

**Implementation:** `packages/blobsy/src/config.ts:204-227`
````

---

#### Issue #12: Remote Checksum Support Deferred but Not Isolated

**Affected files:**
- [blobsy-design.md:868-879](../../design/current/blobsy-design.md) (Remote checksum
  proposal)
- [blobsy-design.md:572](../../design/current/blobsy-design.md) (Ref format field
  ordering)
- [issues-history.md:134](../../design/current/issues-history.md)

**Problem:** The design proposes an optional `remote_checksum` field in `.bref` for V2.
However, the field ordering in the ref format (line 572) doesn't reserve space for this,
and the parsing code might not ignore unknown fields.
This creates:
- Forward/backward compatibility risk
- Unclear field ordering for the future version

**Impact:** V1 code reading a V2 `.bref` with `remote_checksum` might fail or ignore it
incorrectly.

**Recommended fix:** Document the forward compatibility strategy:
1. V1 parser ignores unknown fields on read (defensive parsing)
2. Reserve field ordering position for `remote_checksum` in documentation
3. Add note that `.bref` format is designed for forward compatibility
4. Show example of V1 parser reading V2 `.bref` with extra fields

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

After line 589 (after the Bref format table), add:

```markdown
**Forward Compatibility Strategy:**

The `.bref` format is designed for forward compatibility across versions:

1. **Format version field** (`format: blobsy-bref/0.1`):
   - Major version changes (0.x → 1.x) indicate breaking changes
   - Minor version changes (0.1 → 0.2) indicate additive changes
   - V1 parser **allows** newer minor versions, **rejects** newer major versions

2. **Unknown field handling**:
   - V1 parser reads all fields as key-value pairs (YAML parsing)
   - Unknown fields are **ignored** during validation (defensive parsing)
   - Known fields are validated, unknown fields pass through

3. **Field ordering is stable** (see line 572-577):
   - Fields always written in same order to minimize git diff noise
   - New fields in V2 will be appended after existing fields

**Example: V1 Parser Reading V2 .bref**

V2 `.bref` with `remote_checksum` field:
```yaml
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.2
hash: sha256:7a3f0e...
size: 15728640
remote_key: sha256/7a3f0e...
compressed: zstd
compressed_size: 8421376
remote_checksum: etag:d41d8cd98f00b204e9800998ecf8427e  # V2 field
````

V1 parser behavior:
- Reads `format: blobsy-bref/0.2` → **Accepts** (minor version bump)
- Validates required fields: `hash`, `size` → ✅ Present and valid
- Reads `remote_checksum` field → **Ignores** (unknown field)
- Result: Successfully reads `.bref`, ignores V2-specific field

**Implementation:** `packages/blobsy/src/ref.ts:89-117` (validateFormatVersion function)

**Reserved Field Ordering (V2 Proposal):**

Future `.bref` fields will follow this order:
```yaml
format: ...
hash: ...
size: ...
remote_key: ...
compressed: ...
compressed_size: ...
remote_checksum: ...      # V2: Provider ETag/checksum (e.g., "etag:d41d8cd98f...")
last_verified: ...        # V2: Timestamp of last integrity check
```

This ordering ensures V1 and V2 `.bref` files have minimal diff noise.
```

---

#### Issue #13: Transfer Tool Delegation Completely Deferred

**Affected files:**
- [blobsy-backend-and-transport-design.md:460-502](../../design/current/blobsy-backend-and-transport-design.md)
  (Tool delegation design)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md:178-182](plan-2026-02-21-blobsy-phase2-v1-completion.md)

**Problem:** The design describes transfer tool delegation (aws-cli, rclone, etc.)
in detail (lines 460-502), but Phase 2 plan explicitly defers this:
- Phase 1 uses local backend only
- Phase 2 uses built-in S3 SDK for S3 transfers
- Tool delegation deferred to V1.1

Yet the design doc is written as if tool delegation exists.
This creates confusion about what's shipped vs.
designed.

**Impact:** Maintenance burden: design doc doesn't match V1 implementation.
New contributors may think tool delegation is implemented.

**Recommended fix:** Add a "V1 Implementation Scope" box early in
backend-and-transport-design.md:
```
> **V1 Implementation Scope**: Tool delegation (aws-cli, rclone) is fully designed but
> deferred to V1.1. V1.0 ships with built-in S3 SDK and local filesystem backends only.
> See [issues-history.md](issues-history.md) for rationale.
````

Add similar notes in other sections describing V1.1+ features.

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-backend-and-transport-design.md`**

Add immediately after the title (before line 1 content):

```markdown
---
**V1 Implementation Scope:**

✅ **Implemented in V1.0:**
- S3 backend via built-in `@aws-sdk/client-s3` (native TypeScript implementation)
- Local filesystem backend

⏸️ **Deferred to V1.1+:**
- Transfer tool delegation (aws-cli, rclone, s5cmd) - fully designed but not implemented
- GCS backend (`gs://`)
- Azure Blob Storage backend (`az://`)

V1.0 ships with robust S3 and local support. Tool delegation and additional cloud providers are planned for V1.1. See [issues-history.md](issues-history.md) for implementation rationale.

---
````

At line 460 (start of tool delegation section), add a callout:

```diff
+> **🚧 V1.1 Feature - Not Implemented in V1.0**
+>
+> The transfer tool delegation system described in this section is fully designed but deferred to V1.1.
+> V1.0 uses built-in `@aws-sdk/client-s3` for all S3 operations.
+>
+> Reason for deferral: Built-in SDK provides better error handling, progress reporting, and cross-platform consistency. External tools add complexity without significant benefit for V1 use cases.
+
 ## Transfer Tool Delegation
```

At line 502 (end of tool delegation section), add:

```markdown
**V1 Implementation Note:**

In V1, all S3 transfers use the built-in SDK (`@aws-sdk/client-s3`). The `sync.tools` config option is accepted but ignored. Setting it to `["aws-cli"]` or `["rclone"]` will log a warning:
```
Warning: sync.tools is set to ["aws-cli"] but tool delegation is not implemented in
V1.0. Using built-in S3 SDK. Tool delegation will be available in V1.1.
```
```

* * *

#### Issue #14: GCS Backend URL Parsing Implemented but Not Documented in Phase Plan

**Affected files:**
- [plan-2026-02-21-blobsy-phase1-implementation.md:363](plan-2026-02-21-blobsy-phase1-implementation.md)
  (URL parsing)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md:184-186](plan-2026-02-21-blobsy-phase2-v1-completion.md)

**Problem:** The URL parsing module includes GCS (`gs://`) validation (per Phase 1 plan
line 363), but Phase 2 explicitly defers GCS backend implementation.
This means:
- Phase 1 validates GCS URLs but rejects them at runtime (no backend)
- Users can configure `gs://` in `.blobsy.yml` but `blobsy init` will fail
- Unclear error message (backend not found vs.
  URL invalid)

**Impact:** Confusing UX: URL parser accepts GCS, but init rejects it.
Users don’t know if it’s supported.

**Recommended fix:** Document this explicitly:
- Phase 1 accepts GCS URLs for validation purposes
- `blobsy init` will error with clear message:
  `GCS backend (gs://) is deferred to V1.1. Use local: or s3: backends for V1.0.`
- Update error message to be helpful and clear
- Add FAQ entry: “When is GCS support coming?
  V1.1 roadmap.”

**Detailed Line-Level Solution:**

**File: `docs/project/specs/active/plan-2026-02-21-blobsy-phase1-implementation.md`**

At line 363, expand the URL parsing note:

```diff
 **Responsibility:** Parse backend URLs into structured config.
 Validate per-scheme rules.
 Reject unrecognized schemes with helpful errors listing supported options.
+
+**V1 Scope:** URL parsing validates `s3://`, `local://`, `gs://`, and `az://` schemes.
+However, only `s3://` and `local://` backends are implemented in V1.
+
+If user tries to initialize with `gs://` or `az://`, `blobsy init` will show:
+```
+Error: GCS backend (gs://) is not yet implemented.
+
+V1.0 supports:
+  - s3://bucket/prefix (AWS S3)
+  - local://path/to/storage (Local filesystem)
+
+Coming in V1.1:
+  - gs://bucket/prefix (Google Cloud Storage)
+  - az://container/prefix (Azure Blob Storage)
+
+See https://github.com/jlevy/blobsy/issues for roadmap.
+```
```

* * *

* * *

### Implementation Gaps (P1) - Design vs Spec Mismatch

#### Issue #15: Garbage Collection Design Incomplete

**Affected files:**
- [blobsy-design.md:2476-2549](../../design/current/blobsy-design.md)

**Problem:** The GC design section covers three modes (age-based cleanup deferred,
reachability-based GC outlined, branch-cleanup semantics described for V2). However:
- No pseudocode or algorithm for reachability scanning
- No specification of `--depth` or `--older-than` parameters
- No error handling for concurrent GC and push
- Unclear: does GC scan working tree `.bref` files or only HEAD?

**Impact:** V2 implementation will need to guess at semantics.
May lead to inconsistent GC behavior or data loss.

**Recommended fix:** Either:
- **Option A**: Defer the entire GC section to a separate V2 design doc
- **Option B**: Add explicit algorithm pseudocode for reachability scanning now

If keeping in main design, add:
- Reachability algorithm: scan HEAD `.bref` → build set → list remote → delete orphans
- Concurrent operation handling: GC fails if working tree has uncommitted `.bref`
  changes
- Parameter specs: `--older-than=30d`, `--depth=all|HEAD|branch`

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

At line 2476 (start of GC section), add:

```markdown
> **V2 Feature - Design Only**
>
> The garbage collection system described in this section is a **design specification for V2**.
> It is **not implemented in V1**. This section serves as the architectural foundation for future implementation.
```

At line 2549 (end of GC section), add complete algorithm specification:

````markdown
## GC Implementation Specification (V2)

### Reachability Algorithm

**Goal:** Delete remote blobs not referenced by any `.bref` in reachable commits.

**Algorithm:**

```python
def gc_reachability(depth='all', older_than=None, dry_run=False):
    # Step 1: Collect all refs to scan
    if depth == 'HEAD':
        refs_to_scan = [current_HEAD]
    elif depth == 'branch':
        refs_to_scan = [current_branch_commits()]
    else:  # depth == 'all'
        refs_to_scan = all_commits_reachable_from_all_branches_and_tags()

    # Step 2: Build reachable set
    reachable_remote_keys = set()
    for commit in refs_to_scan:
        bref_files = find_bref_files_in_commit(commit)
        for bref_path in bref_files:
            bref = read_bref_from_commit(commit, bref_path)
            if bref.remote_key:
                reachable_remote_keys.add(bref.remote_key)

    # Step 3: List all remote blobs
    all_remote_keys = backend.list_all_blobs()

    # Step 4: Compute orphans
    orphaned_keys = all_remote_keys - reachable_remote_keys

    # Step 5: Apply age filter
    if older_than:
        orphaned_keys = filter_by_age(orphaned_keys, older_than)

    # Step 6: Delete (or dry-run report)
    if dry_run:
        print(f"Would delete {len(orphaned_keys)} orphaned blobs:")
        for key in orphaned_keys:
            print(f"  {key}")
        return orphaned_keys
    else:
        for key in orphaned_keys:
            backend.delete_blob(key)
        print(f"Deleted {len(orphaned_keys)} orphaned blobs")
        return orphaned_keys
````

**Parameters:**

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `--depth` | enum | `all` | Scan depth: `all` (all branches/tags), `branch` (current branch only), `HEAD` (current commit only) |
| `--older-than` | duration | none | Only delete blobs older than this age (e.g., `30d`, `6mo`, `1y`) |
| `--dry-run` | boolean | false | Show what would be deleted without actually deleting |
| `--include-worktree` | boolean | false | If true, also consider `.bref` files in working tree (not just HEAD) |

**Example Usage:**

```bash
# Dry run: see what would be deleted
blobsy gc --dry-run

# Delete orphaned blobs older than 30 days
blobsy gc --older-than=30d

# Aggressive: delete all orphaned blobs
blobsy gc

# Conservative: delete only from current branch, older than 90 days
blobsy gc --depth=branch --older-than=90d
```

**Concurrent Operation Handling:**

| Scenario | Behavior |
| --- | --- |
| GC runs while working tree has uncommitted `.bref` changes | **Error:** “Cannot run GC with uncommitted .bref files. Commit or stash changes.” |
| GC runs during active `push` operation | **Safe:** Newly-pushed blobs have refs in working tree; won’t be deleted (if `--include-worktree` enabled) |
| Multiple users run GC concurrently | **Safe:** Deletion is idempotent; last delete wins (both see same orphans) |
| User pushes while GC is running | **Risk:** Blob could be deleted between push and commit. **Mitigation:** Always commit immediately after push (pre-commit hook enforces this) |

**Safety Guarantees:**

1. **Never deletes blobs referenced in HEAD** (any branch, any tag)
2. **Dry-run by default recommended** for first GC run
3. **Age-based safety**: `--older-than` prevents deleting recent blobs
4. **Worktree protection**: Optional `--include-worktree` flag protects uncommitted refs

**Performance:**

- Scanning 10,000 commits with 1,000 `.bref` files each: ~30 seconds
- Listing 100,000 remote blobs: ~10 seconds (S3 `ListObjectsV2` pagination)
- Total GC time for large repo: ~1-2 minutes

**Future Optimization (V3):**

- Incremental GC: Track last GC timestamp, only scan new commits
- Bloom filter: Use probabilistic data structure for faster reachability checks
````

---

#### Issue #16: `check-unpushed` vs `pre-push-check` Duplicate Functionality

**Affected files:**
- [plan-2026-02-21-blobsy-phase1-implementation.md:92-93](plan-2026-02-21-blobsy-phase1-implementation.md)

**Problem:** Two commands have overlapping purposes:
- `blobsy check-unpushed`: Find committed `.bref` files with no `remote_key` or missing
  blobs
- `blobsy pre-push-check`: Verify all `.bref` files in HEAD have remote blobs

But the descriptions and use cases aren't clearly differentiated:
- When would you use check-unpushed vs.
  pre-push-check?
- What's the difference in output?
- Why are there two commands?

**Impact:** UX confusion, potential for users to use the wrong command.

**Recommended fix:** Document clearly:
- `check-unpushed`: Interactive mode, shows attribution (who committed what), file
  paths, helpful for manual review
- `pre-push-check`: CI-only binary pass/fail gate, exits non-zero if any unpushed refs,
  no attribution needed

Add examples:
```bash
# Local development: see what needs pushing
blobsy check-unpushed

# CI gate: block git push if blobs not uploaded
blobsy pre-push-check && git push origin main
````

**Detailed Line-Level Solution:**

**File: `docs/project/specs/active/plan-2026-02-21-blobsy-phase1-implementation.md`**

At lines 92-93, expand the command descriptions:

```diff
-| `blobsy check-unpushed` | Find committed `.bref` files with no `remote_key` or missing remote blobs. Use git blame for attribution. |
-| `blobsy pre-push-check` | CI-friendly: verify all `.bref` files in HEAD have remote blobs. Exit 0 or 1. |
+| `blobsy check-unpushed` | **Interactive mode:** Find committed `.bref` files with no `remote_key` or missing remote blobs. Shows **file paths, commit authors (git blame), and suggested fix**. Supports `--json` for scripting. Use for: manual review, finding who committed unpushed refs, bulk repair planning. |
+| `blobsy pre-push-check` | **CI-only mode:** Verify all `.bref` files in HEAD have remote blobs. **Binary pass/fail** (exit 0 if all pushed, exit 1 if any missing). **No attribution**, **no suggestions**. Use in `.github/workflows` or git hooks to block merges if blobs not uploaded. |
```

After line 93, add new section:

````markdown
#### Command Comparison: `check-unpushed` vs `pre-push-check`

| Aspect | `check-unpushed` | `pre-push-check` |
|--------|------------------|------------------|
| **Purpose** | Interactive diagnosis | CI gate |
| **Output** | Detailed file list with attribution | Pass/fail only |
| **Exit Code** | Always 0 (even if unpushed refs found) | 0 = all pushed, 1 = some missing |
| **Git Blame** | ✅ Yes (shows author + commit) | ❌ No |
| **Suggested Fix** | ✅ Yes ("Run blobsy push <files>") | ❌ No |
| **JSON Support** | ✅ `--json` flag | ❌ No JSON (designed for shell exit code) |
| **Performance** | Slower (git blame for each file) | Faster (no git operations beyond ls-tree) |
| **Use Case** | `blobsy check-unpushed` before code review | `blobsy pre-push-check && git push` in CI |

**Example Workflow:**

```bash
# Developer workflow (local)
$ blobsy check-unpushed

Unpushed refs (2 files):
  data/model.bin (committed by alice@example.com in abc123)
  data/weights.pkl (committed by bob@example.com in def456)

Suggested fix:
  blobsy push data/model.bin data/weights.pkl

# CI workflow (.github/workflows/ci.yml)
- name: Check blobs uploaded
  run: blobsy pre-push-check || (echo "ERROR: Unpushed blobs detected" && exit 1)
````

**Attribution Example (check-unpushed only):**

```bash
$ blobsy check-unpushed --json
{
  "unpushed": [
    {
      "path": "data/model.bin",
      "ref_path": "data/model.bin.bref",
      "hash": "sha256:abc123...",
      "remote_key": null,
      "commit": "abc123def456",
      "author": "Alice <alice@example.com>",
      "author_date": "2026-02-20T14:32:00Z"
    }
  ]
}
```

**CI Integration Example (pre-push-check only):**

```yaml
# .github/workflows/pr-checks.yml
name: PR Checks
on: pull_request

jobs:
  blobs-uploaded:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check blobs uploaded
        run: |
          npm install -g blobsy
          blobsy pre-push-check
      # Exit code 1 fails the workflow automatically
```
````

---

* * *

### Loose Ends (P2) - Unresolved Items

#### Issue #17: Deferred Features Not Tracked Systematically

**Affected files:**
- [issues-history.md:118-142](../../design/current/issues-history.md)
- Scattered throughout design docs

**Problem:** Deferred features are documented but there's no systematic tracking.
For example:
- Dictionary compression (line 124)
- Export/import (line 125)
- Branch name sanitization (line 101)
- GC reachability (line 133)

Each is mentioned but not consolidated in a single "Deferred Features" section with
rationale and proposed V2 scope.

**Impact:** Hard to distinguish between design decisions (won't do) and V2 items (will
do later). Future contributors won't know what's planned.

**Recommended fix:** Add a "Deferred to V2+" section in the main design doc:
- Consolidate all deferred features with rationale
- Link to issues-history for full context
- Classify as V1.1, V2, or Future (no timeline)
- Add brief justification for deferral

**Detailed Line-Level Solution:**

**File: `docs/project/design/current/blobsy-design.md`**

Add new section at end of document (after all main sections):

```markdown
## Appendix: Deferred Features and Roadmap

This section consolidates all features designed but deferred to future versions.

### V1.1 Planned Features

| Feature | Rationale for Deferral | Estimated Scope |
|---------|------------------------|-----------------|
| **Transfer tool delegation** (aws-cli, rclone) | Built-in SDK sufficient for V1; external tools add complexity | ~2 weeks |
| **GCS backend** (`gs://`) | URL parsing ready; backend impl deferred pending user demand | ~1 week |
| **Azure Blob backend** (`az://`) | URL parsing ready; backend impl deferred pending user demand | ~1 week |
| **Command backend health checks** (user-defined) | Optional; unclear if users need it | ~3 days |
| **blobsy clean command** | Automatic temp file cleanup on startup sufficient for V1 | ~2 days |

### V2 Features (No Timeline)

| Feature | Rationale for Deferral | Design Status |
|---------|------------------------|---------------|
| **Garbage collection** (`blobsy gc`) | Complex safety requirements; V1 doesn't generate much orphaned data | Fully designed (see lines 2476-2549) |
| **Branch-isolated mode** (`{git_branch}` variable) | Unclear user demand; adds complexity | Fully designed (see lines 440-459) |
| **Remote checksum storage** (`.bref` `remote_checksum` field) | V1 content-hash sufficient for integrity; ETags are optimization | Format reserved (forward-compatible) |
| **Export/import** (repo-to-repo blob transfer) | Complex; unclear use cases | Not designed |
| **Dictionary compression** (shared compression dictionaries) | Minor storage savings; high complexity | Not designed |

### Explicitly Won't Do (Design Decisions)

| Feature | Reason Not Implemented |
|---------|------------------------|
| **Nested .bref files** (ref-to-ref indirection) | Adds complexity; no clear use case |
| **Blob versioning** (multiple versions of same blob) | Git already provides versioning; redundant |
| **Partial blob download** (range requests) | Incompatible with hash verification; users should externalize smaller files |
| **Automatic gitignore removal** (when untracking) | Too risky; users may have manual gitignore entries |
| **In-repo blob encryption** | Cloud provider encryption sufficient; key management adds complexity |

**Rationale Sources:**
- See [issues-history.md](issues-history.md) for detailed rationale and review discussions
- V1.1 timeline based on implementation complexity estimates
- V2 features dependent on user feedback and demand signals
````

* * *

#### Issue #18: Error Message Examples Don’t Cover All Categories

**Affected files:**
- [blobsy-backend-and-transport-design.md:701-795](../../design/current/blobsy-backend-and-transport-design.md)
  (Example errors)
- [blobsy-backend-and-transport-design.md:640-648](../../design/current/blobsy-backend-and-transport-design.md)
  (Error categories)

**Problem:** Error categories defined (line 640-648) but only some have example output.
Missing examples:
- `quota` errors (RequestLimitExceeded)
- `storage_full` errors (from S3? or local only?)
- Compound errors (e.g., both network and permission issues)

**Impact:** Implementation may categorize errors differently than expected.
Inconsistent error handling.

**Recommended fix:** Add at least one example for each error category:
- Show S3 `quota` error with suggested fix
- Show local disk `storage_full` error
- Show compound error handling (network timeout → retry → permission error → fail)
- Mark which categories are S3-only vs.
  universal

* * *

#### Issue #19: Temp File Cleanup Strategy Incomplete

**Affected files:**
- [blobsy-backend-and-transport-design.md:562-570](../../design/current/blobsy-backend-and-transport-design.md)
  (Temp file pattern)
- [blobsy-design.md](../../design/current/blobsy-design.md) (no cleanup strategy
  mentioned)

**Problem:** The design says:
- Temp files use pattern `.blobsy-tmp-*`
- `blobsy doctor` reports orphaned temp files
- On startup or via `blobsy clean`, orphaned files are removed

But:
- No `blobsy clean` command is specified in the CLI commands section
- How does startup cleanup work?
  Every command startup?
- What’s the age threshold for “orphaned”?

**Impact:** Temp files may accumulate if cleanup doesn’t run.
Users don’t know how to clean up.

**Recommended fix:** Either:
- **Option A**: Add `blobsy clean` command specification
- **Option B**: Clarify cleanup is automatic on every command startup (with optional age
  threshold config like `cleanup.temp_file_age: 24h`)

Document that `blobsy doctor` detects temp files older than threshold and suggests
cleanup.

* * *

#### Issue #20: Compression Algorithm Windows Support Unclear

**Affected files:**
- [plan-2026-02-21-blobsy-phase1-implementation.md:727-728](plan-2026-02-21-blobsy-phase1-implementation.md)

**Problem:** Compression uses Node.js built-in `node:zlib` with zstd, gzip, brotli.
Design specifies:
- Zstd minimum Node.js 22.11.0
- But doesn’t specify Windows compatibility
- Does zstd work on Windows?
  What about older Windows versions?

**Impact:** Windows users may encounter unsupported compression errors.
Unclear which algorithms are safe to use cross-platform.

**Recommended fix:** Add explicit Node.js version matrix for each OS: | Algorithm |
Linux | macOS | Windows | Min Node.js |
|-----------|-------|-------|---------|-------------| | gzip | ✓ | ✓ | ✓ | 18.0.0 | |
brotli | ✓ | ✓ | ✓ | 18.0.0 | | zstd | ✓ | ✓ | ✓ | 22.11.0 |

Note: Verify zstd Windows support and document any limitations.

* * *

#### Issue #21: Pre-Commit Hook Behavior with Staged .bref Files Underspecified

**Affected files:**
- [blobsy-implementation-notes.md:99-127](../../design/current/blobsy-implementation-notes.md)

**Problem:** The hook implementation calls `push()` directly, then re-stages updated
`.bref` files. But:
- What if push fails? Does the commit block?
- What if re-staging fails?
  (probably shouldn’t)
- Can user bypass the hook with `--no-verify`?
- What if multiple staged `.bref` files; does it push all or stop on first error?

**Impact:** Unpredictable commit flow if errors occur.
Users don’t know if commit will succeed.

**Recommended fix:** Document:
1. Hook fails the commit on any push failure
2. Shows clear error message with failed file
3. User can fix and retry commit
4. Hook always re-stages successfully-pushed refs even if some fail
5. User can bypass with `git commit --no-verify` (but discouraged)
6. If multiple files, pushes all and reports all failures at end

* * *

* * *

### Minor Issues (P3) - Low Priority Improvements

#### Issue #22: Path Normalization Inconsistency for Windows

**Affected files:**
- [blobsy-design.md:302-307](../../design/current/blobsy-design.md)

**Problem:** States POSIX forward slashes used for remote keys on all OSes.
But doesn’t specify:
- When Windows paths are converted (during template evaluation?
  At backend selection?)
- What about UNC paths (`\\server\share`)?
- Does gitignore use forward slashes too?

**Impact:** Potential Windows-specific bugs.
Inconsistent path handling.

**Recommended fix:** Document in `paths.ts` that:
- All internal path operations normalize to POSIX immediately on input
- Windows backslashes converted at CLI entry points
- UNC paths not supported (error with clear message)
- `.gitignore` always uses forward slashes (Git convention)

Add cross-reference from design doc to `paths.ts` implementation.

* * *

#### Issue #23: `.bref` Comment Header Not Self-Contained

**Affected files:**
- [blobsy-design.md:576-577](../../design/current/blobsy-design.md) (Comment header
  spec)
- [plan-2026-02-21-blobsy-phase2-v1-completion.md:288-292](plan-2026-02-21-blobsy-phase2-v1-completion.md)

**Problem:** The comment header is just a URL and one-liner.
An agent encountering a `.bref` file for the first time needs to run `blobsy status` or
`blobsy --help` to understand the system.
Design says it should be “self-documenting” but the header is minimal.

**Impact:** Agents onboarding to a new repo with blobsy need external help.
Not truly self-documenting.

**Recommended fix:** Expand comment header to include:
```yaml
# blobsy ref file - see https://github.com/jlevy/blobsy
# This file represents a large file tracked by blobsy and stored remotely.
# To restore: blobsy pull <path>
# To update: blobsy track <path>
# For help: blobsy --help
```

Update design doc with expanded header format.

* * *

#### Issue #24: Hash Algorithm Agility Field Name Inconsistent

**Affected files:**
- [blobsy-design.md:589](../../design/current/blobsy-design.md) (`.bref` format)
- [issues-history.md:99](../../design/current/issues-history.md)

**Problem:** The design shows `hash: sha256:7a3f0e...` but the field is generic.
If you want to support other algorithms, you’d need:
- Option A: Change field name to `content_hash` and include algorithm in value
- Option B: Add `hash_algorithm` field

Design doesn’t specify which approach for future-proofing.

**Impact:** Future upgrades may require `.bref` migration.
Unclear how to add new hash algorithms.

**Recommended fix:** Document:
- V1 uses `hash` field with algorithm prefix (`sha256:`, future `blake3:` etc.)
- Field value format: `<algorithm>:<hex-digest>`
- Parser extracts algorithm from prefix
- Field ordering reserves position for optional `hash_algorithm` field in future
  versions (for redundancy/validation)

* * *

#### Issue #25: Schema Version in JSON Output Inconsistent

**Affected files:**
- [plan-2026-02-21-blobsy-phase1-implementation.md:173, 1131-1136](plan-2026-02-21-blobsy-phase1-implementation.md)
- [blobsy-backend-and-transport-design.md:614-634](../../design/current/blobsy-backend-and-transport-design.md)

**Problem:** Both documents specify `"schema_version": "0.1"` in JSON output.
But:
- Is this the blobsy version or a separate schema version?
- When does it increment?
  Per command? Per release?
- What happens if you upgrade blobsy and clients parse old schema?

**Impact:** Version mismatch bugs in agent consumers of JSON output.
Unclear versioning strategy.

**Recommended fix:** Document:
- `schema_version` is independent of blobsy version
- Increments only when JSON structure changes (breaking or significant additive changes)
- Format: `"major.minor"` (e.g., `"1.0"`, `"1.1"`, `"2.0"`)
- Clients should check schema version and warn on mismatch
- Add schema changelog in design doc

* * *

### Additional Discovered Issues

#### Issue #26: Stat Cache Cache Entry Path Not Documented in Main Design

**Affected files:**
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md)
- `packages/blobsy/src/paths.ts:65-69` (implementation exists)

**Problem:** Stat cache design doesn’t document the file path structure for cache
entries.

**Impact:** Implementation details not visible in design documentation.

**Recommended fix:** Add cache entry file structure documentation to
stat-cache-design.md.

**Detailed Line-Level Solution:**

Add to stat-cache-design.md after line 200:

```markdown
### Cache Entry File Structure

Cache entries are stored in `.blobsy/stat-cache/` with 2-character sharding:

**Path Pattern:** `.blobsy/stat-cache/{prefix}/{hash}.json`

Where:
- `{prefix}` = first 2 hex chars of SHA-256 hash of repo-relative path
- `{hash}` = next 16 hex chars (18 total)

**Example:**
```
Repo-relative path: data/research/model.bin SHA-256(path):
7a3f0e9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f … Prefix: 7a Hash: 3f0e9b2c1d4e5f6a Cache file:
.blobsy/stat-cache/7a/3f0e9b2c1d4e5f6a.json
```

**Sharding Rationale:**
- Prevents "too many files in one directory" filesystem issues
- 256 possible prefix directories (00-ff)
- Typical repo with 10,000 tracked files → ~39 files per directory

**Implementation:** `packages/blobsy/src/paths.ts:65-69`
```

* * *

#### Issue #27: Default Template Timestamp Duplication Risk

**Affected files:**
- [blobsy-design.md:293-296](../../design/current/blobsy-design.md)
- `packages/blobsy/src/config.ts:61` (default template)

**Problem:** Default template
`{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}` allows cross-time
duplication risk not clearly documented.

**Impact:** Users may not understand storage implications of timestamp-based templates.

**Recommended fix:** Document cross-time duplication behavior and pure CAS alternative.

**Detailed Line-Level Solution:**

Add after line 296 in blobsy-design.md:

```markdown
**Cross-Time Duplication Behavior:**

The default template (`{iso_date_secs}-{content_sha256_short}/{repo_path}...`) creates **new remote keys** each time the same file is pushed, even if content is identical:
```
# First push (Feb 20, 10:30)

20260220T103000-7a3f0e9b2c1d/data/model.bin.zst

# Second push (Feb 21, 14:00) - same file, same content

20260221T140000-7a3f0e9b2c1d/data/model.bin.zst
````

**Why this happens:** Timestamp is part of the key, so pushing at different times creates different keys.

**Storage implications:**
- ✅ Pro: Every push is preserved (audit trail, rollback capability)
- ❌ Con: Storage grows over time even for unchanged files
- 💡 Solution: Use `blobsy gc` (V2) to clean up old versions

**Pure deduplication alternative:**

To avoid cross-time duplication, use Pattern 2 (Pure CAS) without timestamp:

```yaml
remote:
  key_template: 'sha256/{content_sha256}/{filename}{compress_suffix}'
````

With this template:
- Same content always produces same key (deduplication across time)
- Storage efficient
- But: no timestamp ordering, harder to browse by date
```

---

* * *

## Implementation Plan

### Phase 1: Pre-V1 Critical Fixes (P0)

Fix issues that would confuse users or create implementation ambiguity:

- [ ] **Issue #1**: Resolve git branch sanitization contradiction
  - Choose Option A or B (remove or clarify deferred status)
  - Update blobsy-design.md and issues-history.md
  - Add V1 implementation status note

- [ ] **Issue #2**: Specify compression suffix interaction
  - Add decision rules to template evaluation section
  - Document when to use `{compress_suffix}` vs automatic
  - Add examples of both modes
  - Specify error/warning for mode switching

- [ ] **Issue #3**: Clarify working tree sync semantics
  - Document warning vs error precedence
  - Add decision tree to stat-cache-design.md
  - Show example output with both cases
  - Cross-reference from main design

- [ ] **Issue #13**: Add V1 scope note to backend design
  - Add "V1 Implementation Scope" box
  - Mark tool delegation as V1.1+
  - Update all V1.1+ feature mentions

### Phase 2: Pre-V1.1 Design Gaps (P1)

Complete specifications before implementing V1.1 features:

- [ ] **Issue #4**: Document stat cache mtime recovery
  - Add recovery flow to stat-cache-design.md
  - Specify `--rebuild-cache` behavior
  - Note mtime limitations

- [ ] **Issue #5**: Specify multi-user collision handling
  - Document timestamp granularity
  - Clarify same-second collision resolution
  - Add example with concurrent pushes

- [ ] **Issue #6**: Complete `blobsy mv` semantics
  - Add directory-spanning move examples
  - Document `.gitignore` cleanup behavior
  - Specify externalization rule re-evaluation

- [ ] **Issue #7**: Clarify externalization rule precedence
  - Document precedence rules
  - Specify subdirectory config replacement behavior
  - Add examples of rule conflicts

- [ ] **Issue #8**: Specify command backend health checks
  - Choose Option A or B (document limitations or allow custom health command)
  - Update backend-and-transport-design.md

- [ ] **Issue #15**: Complete or defer GC design
  - Choose Option A or B (separate doc or add algorithm)
  - If keeping, add reachability algorithm
  - Specify concurrent operation handling

- [ ] **Issue #16**: Differentiate check-unpushed and pre-push-check
  - Document use cases clearly
  - Add output format examples
  - Show CI vs interactive usage

### Phase 3: Documentation Polish (P1-P3)

Improve clarity and completeness:

- [ ] **Issue #9**: Fix "Atomic Writes" section structure
- [ ] **Issue #10**: Clarify `{git_branch}` format
- [ ] **Issue #11**: Document compression size units
- [ ] **Issue #12**: Document forward compatibility strategy
- [ ] **Issue #14**: Clarify GCS URL validation behavior
- [ ] **Issue #17**: Consolidate deferred features
- [ ] **Issue #18**: Add missing error examples
- [ ] **Issue #19**: Specify temp file cleanup
- [ ] **Issue #20**: Add compression OS compatibility matrix
- [ ] **Issue #21**: Document pre-commit hook error handling
- [ ] **Issue #22**: Document Windows path handling
- [ ] **Issue #23**: Expand `.bref` comment header
- [ ] **Issue #24**: Document hash algorithm agility
- [ ] **Issue #25**: Clarify JSON schema versioning
- [ ] **Issue #26**: Document stat cache path structure
- [ ] **Issue #27**: Document cross-time duplication behavior

* * *

## Testing Strategy

No implementation changes, only documentation updates.
Verification:

1. **Cross-reference check**: Ensure all file/line references are accurate
2. **Consistency review**: After fixes, re-run cross-document consistency check
3. **Stakeholder review**: Review critical fixes (#1-3, #13) with maintainers before V1
   release

* * *

## Rollout Plan

1. Create beads for Phase 1 issues (link to this spec)
2. Fix Phase 1 issues before V1.0 release
3. Create beads for Phase 2 issues (link to this spec)
4. Address Phase 2 before V1.1 planning begins
5. Address Phase 3 as time permits (ongoing documentation improvements)

* * *

## Open Questions

None - all issues are well-defined.
Implementation choices documented in "Recommended fix" sections.

* * *

## References

### Design Documents

- [blobsy-design.md](../../design/current/blobsy-design.md) - Main design document
- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
  \- Backend architecture
- [blobsy-implementation-notes.md](../../design/current/blobsy-implementation-notes.md)
  \- Implementation details
- [blobsy-stat-cache-design.md](../../design/current/blobsy-stat-cache-design.md) - Stat
  cache algorithm
- [blobsy-testing-design.md](../../design/current/blobsy-testing-design.md) - Testing
  strategy
- [issues-history.md](../../design/current/issues-history.md) - Historical decisions

### Implementation Specs

- [plan-2026-02-21-blobsy-phase1-implementation.md](plan-2026-02-21-blobsy-phase1-implementation.md)
  \- Phase 1 plan
- [plan-2026-02-21-blobsy-phase2-v1-completion.md](plan-2026-02-21-blobsy-phase2-v1-completion.md)
  \- Phase 2 plan
- [golden-test-coverage-matrix.md](golden-test-coverage-matrix.md) - Test coverage

### Review Output

Original comprehensive review conducted 2026-02-21, identifying 27 distinct issues
(25 original + 2 discovered during detailed solution development) across all documentation.
```
