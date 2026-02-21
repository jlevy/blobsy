---
type: is
id: is-01khzaheyhvtmrrppyd0sb0754
title: Pre-commit hook doesn't re-stage .yref after blobsy push (causes missing remote_key)
kind: bug
status: closed
priority: 0
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T05:25:13.296Z
updated_at: 2026-02-21T05:43:40.172Z
closed_at: 2026-02-21T05:43:40.170Z
close_reason: Added 'git add' command after successful push in pre-commit hook (line 142). This ensures updated .yref files (with remote_key) are re-staged before commit proceeds.
---
**Location:** docs/project/design/current/conflict-detection-and-resolution.md:108-165

**Bug:** The pre-commit hook runs `blobsy push` which writes `remote_key` back into .yref files (line 289-290), but the hook doesn't re-stage these updated files before the commit proceeds. Git commits the originally-staged version (without remote_key).

**Result:** 
- Committed .yref has correct hash but **no remote_key**
- Other users who pull get "missing (no remote\!)" errors even though blob was uploaded
- The remote_key only exists in uncommitted working tree

**Fix:** After line 139 (successful push), add:
```bash
# Re-stage updated .yref files (now containing remote_key)
echo "$YREF_FILES" | xargs git add
```

**Impact:** HIGH - Breaks the primary prevention layer and causes sync failures for all team members

**File:** docs/project/design/current/conflict-detection-and-resolution.md
