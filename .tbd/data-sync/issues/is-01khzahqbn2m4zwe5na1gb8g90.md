---
type: is
id: is-01khzahqbn2m4zwe5na1gb8g90
title: Case 6 in three-way merge is unreachable dead code (duplicates Case 3)
kind: bug
status: closed
priority: 0
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T05:25:21.907Z
updated_at: 2026-02-21T05:44:23.063Z
closed_at: 2026-02-21T05:44:23.062Z
close_reason: Removed unreachable Case 6 (lines 477-490) which was duplicate of Case 3. Fixed decision table row A|B|B - removed incorrect 'Pull or warn' entry. The state local=A, ref=B, cache=B is actually impossible to reach (Case 3 handles local=A, ref=B, cache=A and returns early).
---
**Location:** docs/project/design/current/conflict-detection-and-resolution.md:468-481

**Bug:** Case 6 checks `localHash === cached.hash && ref.hash \!== cached.hash` but Case 3 (lines 410-437) checks the **identical condition** and returns early. Case 6 can never execute.

**Decision table inconsistency:** Line 369 shows:
| A | B | B | User reverted file to old version | Pull or warn |

But this state (local=A, ref=B, cache=B) would be handled by Case 4 (local differs from cache, ref matches cache) which **pushes** the new local version. The table says "Pull or warn" but code would push.

**Fix:**
1. Remove Case 6 (lines 468-481) - it's unreachable
2. Fix decision table row - change to:
   | A | B | B | Local modified, ref+cache agree | Push (user edited locally) |

**Impact:** HIGH - Code doesn't match design doc, misleading for implementers

**File:** docs/project/design/current/conflict-detection-and-resolution.md
