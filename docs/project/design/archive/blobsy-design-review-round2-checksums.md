# Review: blobsy Checksums and Integrity Model (Round 2)

**Reviewer:** Claude (senior technical review)

**Date:** 2026-02-19

**Document reviewed:** [blobsy-design.md](blobsy-design.md) (2026-02-18)

**Context:** The Round 1 review flagged directory integrity as C1 (critical) and
manifest mtime as S3 (significant).
A follow-up analysis argued that transport-layer checksums (S3 ETags, Content-MD5,
`x-amz-checksum-sha256`) already cover transfer integrity, and that blobsy-level hashing
adds complexity without proportional value.
This review examines the question in depth and provides specific recommendations.

* * *

## The Three Integrity Layers

The checksum question is really three separate questions, each with a different answer:

| Layer | Question | Who handles it? |
| --- | --- | --- |
| **Transfer integrity** | Did the bytes arrive intact? | Transport tools (S3 ETags, Content-MD5, rclone checksums) |
| **Change detection** | Has this file changed since last sync? | Unspecified for directories in current design |
| **At-rest verification** | Does this local file match what was pushed? | SHA-256 in pointer (single files only) |

* * *

## Layer 1: Transfer Integrity -- Already Solved

S3 verifies uploads via ETags (MD5 for single-part uploads, opaque hash for multipart).
Since late 2021, S3 also supports `x-amz-checksum-sha256` natively on upload and
download. `aws s3 sync` and `rclone` both verify transfers internally.

Blobsy does not need to re-solve transfer integrity.
The Round 1 review overstated this risk when calling C1 “dangerously weak” -- the
“silent data corruption during transfer” scenario is already handled by the transport
layer.

**Verdict: No blobsy-level work needed.
Transport tools provide adequate transfer integrity.**

* * *

## Layer 2: Change Detection -- The Real Problem

This is where the design has a genuine gap, and it is more important than the “downgrade
to significant” assessment suggests.

### Why mtime Fails for the Core Workflow

The design says directories use manifests with `mtime` and `size` for change detection.
But **branch switching is a core blobsy workflow**, not an edge case.
The default namespace mode is `branch`. The example session in the design demonstrates:
checkout branch, push, checkout different branch, push.

Every `git checkout` sets mtime on every modified file to “now.”
After a branch switch:

- `blobsy status` shows every tracked file as “changed” (false positives)
- `blobsy push` re-uploads everything unnecessarily
- The user experience degrades from “smart incremental sync” to “dumb full-directory
  upload”

Other environments where mtime is unreliable:

- **CI runners**: Fresh checkout, all files have checkout timestamp
- **Docker containers**: Build layers reset timestamps
- **NFS / network filesystems**: Clock skew between client and server
- **FAT32 / exFAT**: 2-second mtime resolution (USB drives, SD cards)

### Why Size Alone Is Insufficient

Size comparison catches the majority of real changes but has a meaningful false-negative
rate. A JSON file where a value changes but structure is preserved, a CSV where one cell
is updated, a config file with a flag toggle -- these are same-size modifications that
are common in practice.

Size is a useful fast-path optimization but cannot be the only signal.

### Why Hashing During Push Is Essentially Free

On `blobsy push` for a directory, blobsy already reads every file to upload it.
Computing SHA-256 during that read adds negligible overhead:

- SHA-256 throughput: ~400-600 MB/s on modern hardware (faster with hardware
  acceleration)
- A directory with 1,000 files totaling 1 GB: ~2 seconds of hashing
- The upload itself will take orders of magnitude longer (even on a fast connection)

The hash computation piggybacks on I/O that is already happening.
It is not an additional pass over the data.

### How Git Solves the Same Problem

Git’s own index faces the same mtime challenge.
Git stores full stat data (dev, ino, mode, uid, gid, size, mtime, ctime) in the index.
If any stat field changes, git re-reads the file and rehashes.
If all stat fields match, git assumes unchanged.

The critical difference: git re-hashes when mtime changes.
It uses mtime as a “definitely changed” signal, not as an “unchanged” signal.
This is the right approach -- mtime tells you something changed but cannot tell you
nothing changed.

### What Other Tools Do

| Tool | Change detection | Hash role |
| --- | --- | --- |
| `aws s3 sync` | Size + mtime (default) or ETag (MD5) with `--exact-timestamps` | Optional, via flag |
| `rclone` | Size + mtime (default) or hash with `--checksum` | Optional, via flag |
| `rsync` | Size + mtime (default) or full checksum with `-c` | Optional, via flag |
| `DVC` | MD5 hash of content | Always, stored in `.dvc` file |
| `git` | Stat data as fast-path, re-hash when stat changes | Always, stored in index |

The industry pattern is clear: size + mtime as fast path, with hash as the reliable
fallback. DVC and git always hash.
Sync tools make it optional but available.

For blobsy, where branch switching is a core workflow and mtime is guaranteed to be
unreliable after every checkout, the hash path is not optional -- it is the primary
mechanism for correct behavior.

* * *

## Layer 3: At-Rest Verification -- Nice-to-Have, Not Critical

With per-file hashes in the manifest, `blobsy verify` for directories becomes trivial:
hash each local file, compare against manifest, report mismatches.
This completes the tool’s integrity story but is not critical for V1 launch.

Post-download verification (checking files after `blobsy pull`) is also a nice-to-have.
The transport already verified the transfer.
For belt-and-suspenders, offer it as a config flag (`verify_after_pull: true`, default
false).

**Verdict: Implement `blobsy verify` for directories once manifest hashes exist.
Not a launch blocker.**

* * *

## Recommended Design

### Manifest Format: Add Per-File Hashes

```json
{
  "format": "blobsy-manifest/0.1",
  "updated": "2026-02-18T12:00:00Z",
  "files": [
    {
      "path": "report.md",
      "size": 4096,
      "sha256": "7a3f0e..."
    },
    {
      "path": "raw/response.json",
      "size": 1048576,
      "sha256": "b4c8d2..."
    }
  ],
  "total_size": 1052672
}
```

Changes from current design:

- **Add `sha256` to every file entry.** Computed during push, stored in manifest.
- **Remove `mtime` from file entries.** It is unreliable and not used for any decision.
  If there is a use case for informational mtime, add it back as an optional field, but
  it must not be used for change detection.

### Change Detection: Two-Tier Approach

**`blobsy status` (fast, offline):** Compare local file sizes against manifest.
This is a stat-only operation (no file reads) and returns instantly.
Files where size differs: report as “modified.”
Files where size matches: report as “ok” (with the understanding that rare same-size
modifications are a known limitation of the fast path).
For definitive verification: `blobsy verify`.

**`blobsy push` (accurate, pre-upload):** Hash each local file.
Compare against manifest hashes.
Skip files where hash matches (no re-upload needed).
This prevents unnecessary re-uploads after branch switches, where size matches but mtime
changed and the content is actually identical.

The push hash comparison is the key payoff.
Without it, every branch switch triggers a full re-upload of unchanged files.
With it, push correctly identifies “nothing changed” and skips.

**`blobsy pull` (with manifest):** Fetch manifest.
Compare local sizes and hashes against manifest.
Download only files where local hash differs or file is missing.

### Integrity Model Section: Revised

The Integrity Model section should reflect a unified approach for both single files and
directories:

- **Single files:** SHA-256 in the pointer file.
  Enables change detection, `blobsy verify`, and meaningful `git diff` on pointers.
- **Directories (with manifest):** Per-file SHA-256 in the remote manifest.
  Computed during push (zero additional I/O cost).
  Enables accurate change detection during push and pull, and `blobsy verify` for
  directories.
- **Directories (without manifest):** Change detection delegated entirely to transport
  tool. `blobsy verify` is not available.

### Config: Simplify Checksum Options

The current config offers `sha256 | md5 | xxhash | none`. With the recommended approach:

- `sha256` should be the only default.
  MD5 is weaker and not meaningfully faster for the file sizes blobsy targets.
  xxhash adds a dependency.
- `none` should remain as an explicit opt-out for users with very large directories
  where even piggybacked hashing is unwanted.
- Drop `md5` and `xxhash` from V1. SHA-256 is fast enough and is already used for single
  files. One algorithm, fewer decisions, simpler code.

```yaml
checksum:
  algorithm: sha256            # sha256 (default) | none
```

If demand emerges for faster hashing on very large datasets, xxhash can be added later
without breaking the config format.

* * *

## Summary

| Decision | Recommendation |
| --- | --- |
| Per-file hashes in manifest | **Always compute, always store.** Computed during push (free). Not optional by default. |
| `blobsy status` | Size comparison only (fast, offline, no file reads). |
| `blobsy push` change detection | Hash comparison against manifest. The key payoff: prevents unnecessary re-uploads after branch switches. |
| `blobsy pull` change detection | Hash + size comparison against manifest. Download only what differs. |
| `blobsy verify` for directories | Implement using manifest hashes. Not a V1 launch blocker but easy once hashes exist. |
| Post-pull verification | Off by default. Available via config. Transport handles this adequately. |
| `checksum.algorithm` options | `sha256` (default) and `none`. Drop md5 and xxhash from V1. |
| mtime in manifest | **Remove as a change detection signal.** Not used for any decision. Store as optional informational field only if needed. |
| Transfer integrity | **No blobsy-level work.** Transport tools provide adequate coverage. |

### Reassessment of Round 1 Issues

| Round 1 ID | Round 1 severity | Revised severity | Rationale |
| --- | --- | --- | --- |
| C1 | Critical | **Critical (confirmed), reframed** | Not about transfer integrity (transport handles that). Critical because without manifest hashes, `blobsy push` after `git checkout` re-uploads everything. The core branch-switching workflow is broken without hashes. |
| S3 | Significant | **Absorbed into C1** | mtime unreliability is the same problem as C1. The fix is the same: use hashes, not mtime. |
