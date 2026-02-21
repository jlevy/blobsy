---
type: is
id: is-01khzajfh75pbeqh46az1h500n
title: Add file locking for concurrent blobsy operations
kind: feature
status: closed
priority: 1
version: 2
labels: []
dependencies: []
created_at: 2026-02-21T05:25:46.661Z
updated_at: 2026-02-21T05:34:57.278Z
closed_at: 2026-02-21T05:34:57.277Z
close_reason: "Closing in favor of better design: file-per-entry stat cache eliminates race conditions without file locking complexity"
---
**Source:** Round 6 reviews (Opus 4.6 §3.5, GPT 5 Pro §4.8)

**Problem:** Two blobsy processes running simultaneously can corrupt:
- .yref files (both update remote_key simultaneously)
- Stat cache JSON file (concurrent writes)

**Scenario (Opus review lines 806-818):**
```bash
# Terminal 1: blobsy push (1,000 files)
# Terminal 2: blobsy push (same files)
# Risk: .yref file corruption if both update remote_key
```

**Recommendation:** Add file locking using Node.js exclusive file creation:
```typescript
import { open } from 'fs/promises';

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = await open(lockPath, 'wx');  // Exclusive create
  try {
    return await fn();
  } finally {
    await lockFile.close();
    await unlink(lockPath);
  }
}

// Usage
await withLock('.blobsy/lock', async () => {
  await syncAll();
});
```

**Minimum:** Protect stat cache writes
**Ideal:** Protect all .yref mutations

**File:** Add to conflict-detection-and-resolution.md
