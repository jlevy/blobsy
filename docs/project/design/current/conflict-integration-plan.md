# Integration Plan: Conflict Detection into Main Design

**Date:** 2026-02-21

**Goal:** Integrate conflict detection and resolution design into `blobsy-design-v2.md`.
Keep `conflict-detection-and-resolution.md` and `stat-cache-design.md` as authoritative
references (same pattern: main doc has summary + cross-reference).

**Source documents:**

- [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) --
  three-layer defense (pre-commit hook, stat cache detection, attribution)
- [stat-cache-design.md](stat-cache-design.md) -- stat cache entry format, storage,
  three-way merge algorithm, cache update rules, recovery

## Design Principle

Follow the same pattern used for the stat cache: the main design doc contains a
**summary** of each concern with a **cross-reference** to the detailed document.
This avoids duplication and keeps the main doc readable (already 3200+ lines).

The conflict-detection doc and stat-cache-design doc remain as living references, not
archived.

* * *

## Integration Point 1: `blobsy init` -- Mention Hook Installation

**Location:** `blobsy init` section (currently line ~890)

**Current:** Only mentions `.blobsy.yml` creation and backend configuration.

**Change:** Add a line about hook installation after the existing content.

**New content to append:**

```markdown
Also installs a pre-commit hook that auto-pushes blobs when committing `.yref` files.
See [Conflict Detection](#conflict-detection).
```

**Why:** The conflict-detection doc says `blobsy init` installs hooks.
The main doc should reflect this without duplicating the full hook script.

* * *

## Integration Point 2: `blobsy push` -- Add Sanity Check Behavior

**Location:** `blobsy push` / `blobsy pull` section (currently line ~1232)

**Current:** Describes push as a “convenience alias for one-directional sync” with no
mention of hash verification.

**Change:** Add sanity check description after the existing push description, before
pull behavior.

**New content to insert after “Same per-file logic, just filtered to one direction.”:**

```markdown
**Push sanity check:** Before uploading, `blobsy push` verifies the local file's hash
matches the `.yref` hash. If the file was modified after `blobsy track`, the push fails
with a helpful error. Use `--force` to override (updates `.yref` to match current file,
then pushes). See [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md)
for full push verification logic.
```

**Why:** Push is no longer a thin wrapper -- it has validation logic that the main doc
should describe.

* * *

## Integration Point 3: `blobsy doctor` -- Add Hook Status Check

**Location:** `blobsy doctor` section (currently line ~1343)

**Changes:**

**3a.** In the example output, add a `=== GIT HOOKS ===` section after
`=== REPOSITORY STATE ===`:

```
=== GIT HOOKS ===
✓ pre-commit hook installed (.git/hooks/pre-commit)
  Purpose: Auto-push blobs when committing .yref files
```

**3b.** In the “Common error detection” list (item 2 in V2 enhancements), add:

```markdown
   - Missing pre-commit hook (recommends `blobsy hooks install`)
```

**3c.** In the `--fix` flag description, add:

```markdown
  - Install missing pre-commit hook
```

**Why:** The conflict-detection doc says `blobsy doctor` should check hook status.
The main doc’s doctor section currently has no mention of hooks.

* * *

## Integration Point 4: New CLI Commands

**Location:** After `blobsy doctor` section, before “Command Summary” (currently line
~1451).

**Add three new command sections:**

### `blobsy hooks`

````markdown
### `blobsy hooks`

Manage the pre-commit hook that auto-pushes blobs when committing `.yref` files.

```bash
$ blobsy hooks install
✓ Installed pre-commit hook (.git/hooks/pre-commit)

$ blobsy hooks uninstall
✓ Removed pre-commit hook
````

Installed automatically by `blobsy init`. To bypass the hook for a specific commit:

```bash
$ git commit --no-verify
```

See [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) for
hook implementation details and the full pre-commit script.
````

### `blobsy check-unpushed`

```markdown
### `blobsy check-unpushed`

Find committed `.yref` files whose blobs are missing from remote storage.

```bash
$ blobsy check-unpushed

⚠ Found 2 .yref files in HEAD with missing remote blobs:

  data/model.bin.yref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Issue: remote_key not set (never pushed)

To fix: Run 'blobsy push' to upload missing blobs.
````

Uses git blame to identify who committed each problematic `.yref`. Diagnostic tool for
when team members report “missing (no remote!)” errors.

**Flags:**
- `--json` - Machine-readable output
````

### `blobsy pre-push-check`

```markdown
### `blobsy pre-push-check`

Verify all committed `.yref` files have reachable remote blobs. CI-friendly.

```bash
$ blobsy pre-push-check

✓ All committed .yref files have remote blobs
  Checked 15 .yref files in HEAD
````

**Exit codes:**
- `0` - All `.yref` files have blobs
- `1` - One or more `.yref` files missing blobs

**Use case:** Run in CI before allowing merge to prevent commits with missing blobs from
entering the main branch.
```

* * *

## Integration Point 5: Command Summary Update

**Location:** Command Summary block (currently line ~1454).

**Changes:**

Add under SETUP, after `blobsy doctor`:
```
blobsy hooks install|uninstall Manage pre-commit hook (auto-push on commit)
```

Add under SYNC, after `blobsy stats`:
```
blobsy check-unpushed Find committed .yref files with missing remote blobs blobsy
pre-push-check Verify all .yref files have remote blobs (for CI)
```

Add `[--force]` flag line under `blobsy push`:
```
blobsy push [path...] Upload local blobs to remote, set remote_key [--force] Override
hash mismatch (updates .yref to match file)
````

* * *

## Integration Point 6: Expand Conflict Model Section

**Location:** "Conflict Model" section (currently line ~2341).

**Current content:**

- "Why Conflicts Are Trivially Resolved" -- explains per-file `.yref` = auto-merge
- "Single-Writer Model (V1)" -- one writer per file assumption
- "Comparison to Original Design Conflict Model" -- table comparing manifest vs per-file

**Change:** Keep all existing content. Add a new subsection **before** "Single-Writer
Model" that covers the payload-vs-ref desync problem and the three-layer defense.

**New subsection to insert:**

```markdown
### Conflict Detection

Git handles `.yref` merge conflicts. But there is a second class of conflict that git
cannot see: **payload-vs-ref desynchronization**. Since payload files are gitignored, git
pull can update a `.yref` file while leaving the local payload stale. Without detection,
`blobsy sync` cannot distinguish "user modified the file" from "git pull updated the
ref" and may incorrectly push stale content, reverting someone else's changes.

Blobsy uses a three-layer defense:

1. **Prevention (Primary):** A pre-commit hook (installed by `blobsy init`) auto-runs
   `blobsy push` when committing `.yref` files. This ensures blobs are uploaded before
   refs enter git history. `blobsy push` also verifies the local file hash matches the
   `.yref` hash, catching files modified after tracking.

2. **Detection (Secondary):** The stat cache provides the merge base for three-way
   conflict detection during sync. For each file, blobsy compares the local hash, the
   `.yref` hash, and the cached hash (last known state) to determine the correct action.
   See [stat-cache-design.md](stat-cache-design.md) for the full decision table and
   algorithm.

3. **Attribution (Tertiary):** When a blob is missing from remote storage, error messages
   use git blame to identify who committed the `.yref` without pushing, with actionable
   resolution steps.

See [conflict-detection-and-resolution.md](conflict-detection-and-resolution.md) for
full design: race condition analysis, pre-commit hook implementation, push sanity checks,
attribution error messages, and FAQ.
````

**Why:** This adds the missing information (payload-level conflict detection) without
replacing existing content or inlining the full conflict-detection doc.
The existing subsections (trivially resolved, single-writer, comparison table) remain
as-is.

* * *

## Integration Point 7: Corner Cases -- Light Expansion

**Location:** “Push/Commit Coordination” subsection under “Corner Cases and Pitfalls”
(currently line ~2670).

**Current:** Covers “forgot to commit ref” and “forgot to push data” scenarios.

**Change:** Add two items to the existing subsection:

**7a.** After “Recovery: the original user runs `blobsy push`…” paragraph (line ~2689),
add:

```markdown
**Prevention:** The pre-commit hook (installed by `blobsy init`) auto-pushes blobs when
committing `.yref` files, preventing this scenario. See [Conflict
Detection](#conflict-detection).
```

**7b.** Add a new scenario at the end of the Push/Commit Coordination subsection (before
“### Interrupted Transfers”):

```markdown
**File modified after tracking, before commit.** User runs `blobsy track`, then modifies
the file before committing. The `.yref` hash no longer matches the file. The pre-commit
hook's sanity check catches this: `blobsy push` fails with a hash mismatch error,
blocking the commit. Resolution: re-run `blobsy track` to update the `.yref`.
```

**Why:** Adds pre-commit hook context to existing scenarios without duplicating the full
race condition explanation from the Conflict Model section.
The new scenario (modified after track) is a corner case not covered elsewhere.

* * *

## Integration Point 8: “Not in V1” Clarification

**Location:** “What blobsy does not do (V1)” list (currently line ~3000).

**Current line:**

```
- Multi-writer merge logic (single-writer model; git handles ref conflicts)
```

**Change to:**

```
- Multi-writer merge logic (single-writer model; git handles ref conflicts; stat cache
  detects payload-vs-ref desync but does not auto-resolve -- see [Conflict
  Detection](#conflict-detection))
```

**Why:** The stat cache three-way merge is detection, not resolution.
Blobsy still doesn’t auto-resolve multi-writer conflicts.
But the parenthetical should acknowledge the detection mechanism exists.

* * *

## Integration Point 9: Review Issues Row Update

**Location:** Review Issues Resolution table, row `blobsy-7h13` (currently line ~3192).

**Current resolution:**

> **Eliminated.** No “remote hash Z” needed.
> Conflicts are git conflicts on `.yref` files, resolved with standard git tools.
> Content-addressable = concurrent pushes of different content produce different keys
> (no overwrite).

**Change to:**

> **Eliminated.** No “remote hash Z” needed.
> `.yref` merge conflicts handled by git.
> Payload-vs-ref desync detected by stat cache three-way merge (see
> [Conflict Detection](#conflict-detection)). Content-addressable = concurrent pushes of
> different content produce different keys (no overwrite).

**Why:** Acknowledges that payload-level conflict detection exists, while correctly
noting the original “remote hash Z” approach was eliminated.

* * *

## Integration Point 10: “What This Design Eliminates” Clarification

**Location:** “What This Design Eliminates” list, `blobsy resolve` item (currently line
~3159).

**Current:**

```
- **`blobsy resolve`** -- standard git conflict resolution works.
```

**Change to:**

```
- **`blobsy resolve`** -- standard git conflict resolution works for `.yref` merges.
  Payload-vs-ref desync is detected automatically (see [Conflict
  Detection](#conflict-detection)); no explicit resolve command needed.
```

**Why:** The statement is still true (no resolve command) but should acknowledge that
blobsy does detect payload conflicts, guiding the user to the right action.

* * *

## Fix: Stat Cache API in conflict-detection-and-resolution.md

**Location:** `conflict-detection-and-resolution.md`, lines 304-311 (push code’s stat
cache write).

**Current:**

```typescript
  // 6. Update stat cache
  const stats = await stat(filePath);
  await statCache.set(filePath, {
    hash: ref.hash,
    size: ref.size,
    mtimeNs: stats.mtimeNs.toString(),  // BigInt to string for JSON
    cachedAt: Date.now()
  });
```

**Change to:**

```typescript
  // 6. Update stat cache
  await updateCacheEntry(cacheDir, filePath, ref.hash);
```

**Why:** The current code uses a `statCache.set()` method that doesn’t exist in the
stat-cache-design.md API, and is missing the `path` and `mtimeMs` fields required by
`StatCacheEntry`. The `updateCacheEntry()` function from stat-cache-design.md handles
all of this correctly.
Since this is illustrative pseudocode, the shorter form is clearer and avoids the
inconsistency.

* * *

## Execution Order

1. Fix stat cache API in conflict-detection-and-resolution.md (point “Fix”)
2. `blobsy init` (point 1) -- small addition
3. `blobsy push` (point 2) -- small addition
4. `blobsy doctor` (point 3) -- example output + enhancement list
5. New CLI commands (point 4) -- new sections
6. Command summary (point 5) -- update block
7. Conflict Model section (point 6) -- new subsection
8. Corner Cases (point 7) -- small additions
9. “Not in V1” (point 8) -- one-line edit
10. Review issues row (point 9) -- one cell edit
11. “Eliminates” list (point 10) -- one-line edit

## Post-Integration Verification

After all edits, verify:

- [ ] `conflict-detection-and-resolution.md` is cross-referenced from main doc (Conflict
  Detection subsection, push section, init section)
- [ ] `stat-cache-design.md` cross-references unchanged (already correct)
- [ ] No duplicate content between main doc and conflict-detection doc
- [ ] All new commands (`hooks`, `check-unpushed`, `pre-push-check`) appear in both the
  command sections and command summary
- [ ] `blobsy doctor` mentions hook status in example output, enhancement list, and
  --fix
- [ ] `blobsy init` mentions hook installation
- [ ] `blobsy push` mentions sanity check and `--force`
- [ ] Conflict Model section references both conflict-detection doc and
  stat-cache-design doc
- [ ] “Not in V1” correctly distinguishes detection from resolution
- [ ] Review issues row `blobsy-7h13` acknowledges stat cache detection
- [ ] “Eliminates” list `blobsy resolve` acknowledges detection mechanism
