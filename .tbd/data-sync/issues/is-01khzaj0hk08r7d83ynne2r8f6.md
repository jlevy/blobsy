---
type: is
id: is-01khzaj0hk08r7d83ynne2r8f6
title: No-cache fallback reintroduces race condition (contradicts FAQ, causes data loss)
kind: bug
status: closed
priority: 0
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T05:25:31.314Z
updated_at: 2026-02-21T05:44:53.435Z
closed_at: 2026-02-21T05:44:53.434Z
close_reason: Changed no-cache fallback to throw error with clear guidance instead of auto-pushing (lines 410-426). This prevents the race condition where User B's missing cache + stale local file would revert User A's changes. Now requires user to explicitly choose push vs pull.
---
**Location:** docs/project/design/current/conflict-detection-and-resolution.md:401-407 vs 653-656

**Bug:** When stat cache is missing/corrupted:

**FAQ says (lines 653-656):**
> If local differs from .yref: warn and ask user to clarify intent

**Code does (lines 401-407):**
```typescript
// First time, local differs from ref
// Assume local is truth (user just tracked this)
await updateRefAndPush(filePath, localHash);
```

**Race condition scenario:**
1. User A commits new .yref with hash abc123
2. User B pulls (gets new .yref, but local file still old with hash def456)
3. User B's stat cache is lost/corrupted
4. User B runs `blobsy sync`
5. No cache + local != ref → code auto-pushes def456 → **reverts User A's changes**

This is the **exact race condition** the document is designed to prevent!

**Fix:** Change no-cache fallback to warn+prompt user, never auto-push. Code should match FAQ.

**Impact:** CRITICAL - Reintroduces the data loss race condition when cache is unavailable

**File:** docs/project/design/current/conflict-detection-and-resolution.md
