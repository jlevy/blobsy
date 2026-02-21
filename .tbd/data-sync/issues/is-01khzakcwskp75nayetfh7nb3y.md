---
type: is
id: is-01khzakcwskp75nayetfh7nb3y
title: Define stat cache cleanup policy (stale entries, deleted files)
kind: task
status: closed
priority: 2
version: 2
labels: []
dependencies: []
created_at: 2026-02-21T05:26:16.727Z
updated_at: 2026-02-21T05:37:34.532Z
closed_at: 2026-02-21T05:37:34.531Z
close_reason: Stat cache cleanup is not critical - it's just an optimization. Stale entries cause cache misses (slower but correct). Can defer to V2 or handle if it becomes a real problem.
---
**Location:** docs/project/design/current/conflict-detection-and-resolution.md:494-497

**Problem:** Cache invalidation rules define when to re-hash (size/mtime changed, age > 30 days) but don't address:

1. **Stale entries for deleted/untracked files**
   - If user untracks a file (`blobsy rm`), cache entry remains
   - Cache grows unbounded over time
   
2. **What "revalidate" means** (line 497)
   - Re-hash and update entry?
   - Or discard entry entirely?

3. **30-day threshold justification**
   - Arbitrary choice
   - Large stable datasets legitimately don't change for months
   - Forces unnecessary re-hashing
   - Consider making configurable or removing in favor of `--no-cache` escape hatch

**Recommendations:**
1. Add periodic cleanup: remove cache entries for files that don't have .yref files
2. Clarify "revalidate" means "discard entry, will re-hash on next access"
3. Either justify 30-day threshold or make it configurable
4. Document cache size management (when to prune)

**File:** docs/project/design/current/conflict-detection-and-resolution.md
