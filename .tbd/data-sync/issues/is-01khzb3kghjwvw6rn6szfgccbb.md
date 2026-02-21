---
type: is
id: is-01khzb3kghjwvw6rn6szfgccbb
title: Stat cache should use file-per-entry format (eliminates concurrent write conflicts)
kind: task
status: closed
priority: 1
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T05:35:07.792Z
updated_at: 2026-02-21T11:37:43.897Z
closed_at: 2026-02-21T11:37:43.895Z
close_reason: Stat cache uses file-per-entry format with 2-char prefix sharding, atomic writes, no concurrent write conflicts.
---
**Current design:** Single JSON file at `.blobsy/stat-cache.json`
- Concurrent `blobsy` processes: read entire file, update entries, write back
- Last write wins → loses other process's updates
- Causes cache corruption (performance impact, not data loss)

**Problem with file locking:**
- Not portable across filesystems (NFS, network mounts)
- Performance penalty on some drives
- Added complexity (deadlocks, stale locks, crash cleanup)

**Better solution: File-per-entry**

```
.blobsy/stat-cache/
  <hash-of-path>/
    entry.json
```

Example:
```
.blobsy/stat-cache/a1/b2c3d4.../entry.json
{
  "path": "data/model.bin",
  "hash": "sha256:abc123...",
  "size": 1048576,
  "mtimeNs": "1708468523000000000",
  "cachedAt": 1708468523500
}
```

**Benefits:**
- No concurrent write conflicts (different files)
- Atomic writes via rename (write to temp, rename to final)
- Easy cleanup (delete individual cache files)
- Natural sharding (faster lookups in large repos)
- No file locking needed

**Path hashing:** Use short hash prefix for directory sharding (like git objects):
```typescript
function getCachePath(filePath: string): string {
  const hash = sha256(filePath).substring(0, 16);
  const prefix = hash.substring(0, 2);
  return `.blobsy/stat-cache/${prefix}/${hash}.json`;
}
```

**Cleanup:** Entries for deleted/untracked files can be garbage collected periodically

**File:** docs/project/design/current/conflict-detection-and-resolution.md
