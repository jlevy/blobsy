---
type: is
id: is-01khzajw7mhjsybm1z09qx5z7n
title: Specify BigInt serialization for stat cache nanosecond mtime
kind: task
status: closed
priority: 1
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T05:25:59.667Z
updated_at: 2026-02-21T05:39:02.978Z
closed_at: 2026-02-21T05:39:02.977Z
close_reason: Changed mtimeNs from bigint to string throughout the document. JSON doesn't support BigInt, so we store as string '1708468523000000000' and convert with BigInt(str) when parsing.
---
**Location:** docs/project/design/current/conflict-detection-and-resolution.md:345, 501

**Problem:** Stat cache uses `mtimeNs: bigint` (line 345) and stores to `stat-cache.json` (line 501). JSON does not natively support BigInt:
```javascript
JSON.stringify({mtime: 1n})  // TypeError: Do not know how to serialize a BigInt
```

**Needed:** Specify serialization format in the design doc.

**Options:**
1. **String representation:** `mtimeNs: "1708468523000000000"`
2. **Split to ms + ns:** `{mtimeMs: 1708468523000, mtimeNs: 0}`
3. **Custom replacer/reviver** in JSON.stringify/parse

**Recommendation:** String representation (simplest, preserves full precision)

```typescript
interface StatCacheEntry {
  hash: string;
  size: number;
  mtimeNs: string;  // nanosecond timestamp as string
  cachedAt: number;
}

// Serialize
JSON.stringify({...entry, mtimeNs: entry.mtimeNs.toString()})

// Deserialize
{...parsed, mtimeNs: BigInt(parsed.mtimeNs)}
```

**File:** docs/project/design/current/conflict-detection-and-resolution.md
