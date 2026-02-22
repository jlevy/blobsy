# Agent Handoff: Design Documentation Consistency Fixes

## Task

Implement 27 design documentation fixes with line-level detail using TDD approach.

## Spec

[plan-2026-02-21-design-doc-consistency-fixes.md](docs/project/specs/active/plan-2026-02-21-design-doc-consistency-fixes.md)

**Key sections:**
- Lines 59-257: P0 Critical Issues (#1-3, #13) - **Start here**
- Lines 259-695: P1 Design Gaps (#4-8, #15-16)
- Lines 697-817: P1-P2 Clarity + P3 Minor (#9-27)
- Lines 821-803: Implementation Plan with 3 phases

## Beads

**Epic:** `blobsy-fcu6` - Design Documentation Consistency Fixes (Epic)
- 27 child beads created, all linked to epic
- All beads synced to remote
- Priority breakdown: 4 P0, 7 P1, 10 P2, 6 P3

**Start with P0 beads (must fix before V1):**
```bash
tbd list --parent blobsy-fcu6 --priority P0
```

## Branch

Current: `main` (no feature branch yet - this is documentation-only work) No code
changes, only design doc updates

## PR

Not applicable - documentation updates will be committed directly to main

## Git

Clean working tree - all changes from spec creation already committed

## Context

### What’s Been Done

1. **Comprehensive review** of 6 design docs + 4 implementation specs identified 27
   issues
2. **Detailed line-level solutions** added to spec for each issue, including:
   - Exact file paths and line numbers
   - Specific code changes (shown as diffs)
   - Implementation references (`template.ts:42-69`, etc.)
   - Complete examples and pseudocode
3. **Bead structure** created: 1 epic + 27 child beads organized by priority
4. **Two new issues discovered** during detailed analysis (#26, #27)

### Implementation Approach: Documentation-Driven TDD

**This is NOT traditional code TDD** - these are design documentation fixes.
The “tests” are:
- Cross-reference validation (all file/line refs are accurate)
- Consistency checks (no contradictions between docs)
- Completeness verification (all deferred features documented)

**TDD workflow for each bead:**
1. Read the issue from spec (has detailed solution with line numbers)
2. Locate the target file and line range
3. Read surrounding context to understand current state
4. Apply the documented change (usually adding/modifying markdown sections)
5. Verify cross-references are accurate (links to other docs, code files)
6. Mark bead as complete: `tbd close <id>`

### Specific Implementation Notes

**P0 Issue #1 (Git Branch):**
- Target: `docs/project/design/current/blobsy-design.md:284`
- Also needs: `packages/blobsy/src/template.ts:60` (add TODO comment)
- Watch out: Line numbers may shift as you make changes

**P0 Issue #2 (Compression Suffix):**
- Target: `docs/project/design/current/blobsy-design.md:300`
- Implementation reality: `compress.ts:30-46` shows suffix is ALWAYS automatic
- Add ~70 lines of new markdown explaining collision scenarios

**P0 Issue #3 (Sync Semantics):**
- Two targets: `blobsy-design.md:780` AND `blobsy-stat-cache-design.md:334`
- Cross-doc coordination required

**P0 Issue #13 (Tool Delegation):**
- Target: `docs/project/design/current/blobsy-backend-and-transport-design.md`
  (beginning)
- Add V1 Implementation Scope box before main content

**P1 Issue #15 (GC Design):**
- Largest change: ~100 lines of pseudocode algorithm
- Target: `blobsy-design.md:2549` (end of GC section)
- Complete reachability algorithm with parameters table

**Issue #26 (Stat Cache Path - Discovered):**
- Missing from original review
- Target: `blobsy-stat-cache-design.md:200`
- References implementation at `paths.ts:65-69`

**Issue #27 (Duplication Risk - Discovered):**
- Missing from original review
- Target: `blobsy-design.md:296`
- Explains storage implications of timestamp-based templates

### References

**Implementation context (for verification):**
- `packages/blobsy/src/template.ts:42-69` - Template evaluation
- `packages/blobsy/src/compress.ts:30-46` - Compression decision logic
- `packages/blobsy/src/ref.ts:19-64, 89-117` - .bref parsing/validation
- `packages/blobsy/src/config.ts:204-227` - Size parsing (1mb, 100kb)
- `packages/blobsy/src/paths.ts:51-57, 65-69` - Path normalization + cache paths

**Design doc paths (all relative to `docs/project/design/current/`):**
- `blobsy-design.md` (main design - most changes here)
- `blobsy-backend-and-transport-design.md`
- `blobsy-stat-cache-design.md`
- `blobsy-implementation-notes.md`
- `issues-history.md`

**Spec paths (all relative to `docs/project/specs/active/`):**
- `plan-2026-02-21-blobsy-phase1-implementation.md`
- `plan-2026-02-21-blobsy-phase2-v1-completion.md`

### Challenges & Approach

**Challenge 1: Line numbers shift**
- Solution: Work top-to-bottom in each file, re-find line numbers as you go
- Or: Use text search to find the exact sections (more reliable)

**Challenge 2: Cross-file coordination**
- Some issues require changes to multiple files (e.g., #3 touches 2 files)
- Solution: Make all changes for one issue atomically, commit together

**Challenge 3: Validation**
- No automated tests for documentation consistency
- Solution: After each change, manually verify:
  - Cross-references are valid (file paths exist, line ranges are accurate)
  - No new contradictions introduced
  - Examples/code snippets match implementation

**Challenge 4: Forward compatibility sections**
- Issues #12, #24 involve documenting V2 features in V1 docs
- Solution: Use clear “V2 Specification” or “V2 Proposal” headers
- Mark deferred features consistently

### Recommended Work Order

**Phase 1 (P0 - do first):**
1. Issue #13 (Tool Delegation scope box) - easiest, sets pattern
2. Issue #1 (Git Branch) - touches both design + code comment
3. Issue #2 (Compression Suffix) - large section, practice finding insertion points
4. Issue #3 (Sync Semantics) - multi-file coordination

**Phase 2 (P1):** 5. Issue #4 (Stat Cache Mtime) - adds recovery section 6. Issue #5
(Multi-User Collision) - expands existing note 7. Issue #6 (blobsy mv) - adds new
directory-spanning section 8. Issue #7 (Externalization Rules) - adds precedence section
9\. Issue #8 (Health Check) - adds guidance section 10. Issue #15 (GC Design) -
**largest change**, save for when confident 11. Issue #16 (check-unpushed vs
pre-push-check) - adds comparison table

**Phase 3 (P2-P3 - ongoing):** 12-27. Remaining clarity/minor issues in any order

### Setup

None - all design docs are markdown, no build step needed.

### Verification Checklist (run after each phase)

```bash
# 1. Check all file references are valid
fd -e md . docs/project/design/current docs/project/specs/active | \
  xargs grep -n '\[.*\](.*\.md' | \
  # manually verify paths exist

# 2. Check implementation references
grep -r 'packages/blobsy/src/' docs/project/ | \
  # manually verify file:line refs match actual code

# 3. Cross-check issues resolved
tbd list --parent blobsy-fcu6 --status closed  # should grow as you work

# 4. Verify no markdown lint issues (optional)
pnpm format:check  # runs prettier on markdown
```

## Next Steps

```bash
# 1. Orient yourself
tbd show blobsy-fcu6  # see epic
tbd list --parent blobsy-fcu6 --priority P0  # see P0 beads
tbd ready --parent blobsy-fcu6  # see ready-to-work beads

# 2. Start with first P0 bead
tbd update blobsy-2bv5 --status in_progress  # Issue #13 (easiest)
# Read spec lines 491-570 for detailed solution
# Apply changes to backend-and-transport-design.md
# Verify cross-references
tbd close blobsy-2bv5

# 3. Continue through P0, then P1, then P2-P3
# After each phase, commit and sync:
git add docs/
git commit -m "docs: resolve design consistency issues (Phase N)"
tbd sync
```

Good luck! The spec has all the details - your job is to carefully apply each fix and
verify consistency.
