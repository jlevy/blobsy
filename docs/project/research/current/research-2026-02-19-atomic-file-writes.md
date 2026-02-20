# Research: Atomic File Writes for blobsy Sync Operations

**Date:** 2026-02-19

**Related:**

- [blobsy-design.md](../../design/blobsy-design.md) -- blobsy design document
- [research-sync-tools-landscape.md](research-sync-tools-landscape.md) -- Key findings
  integrated into Section 1.6 (Atomic File Write Behavior Across Transports)

* * *

## Summary

A core design question for blobsy: when pulling files from remote storage, should blobsy
ensure each file is written atomically (temp file + rename)?
Or can it rely on the transport tool to handle this?

**Finding:** AWS CLI and rclone both write atomically by default.
The built-in `@aws-sdk/client-s3` path does not -- blobsy must handle it.
This means the design’s `sync.tool: auto` hierarchy (aws-cli -> rclone -> built-in) has
different atomicity guarantees depending on which tool is selected, and blobsy needs to
fill the gap for the built-in fallback.

* * *

## Transport Tool Behavior

### AWS CLI (`aws s3 cp` / `aws s3 sync`)

**Atomic by default.
No flags needed.**

Since January 2017, the AWS CLI downloads files atomically via the
[s3transfer](https://github.com/boto/s3transfer) library.
The mechanism:

1. `DownloadFilenameOutputManager` generates a temp filename via
   `OSUtils.get_temp_filename()`, which appends a random extension (e.g.,
   `myfile.abc123`) in the **same directory** as the target.
2. Data is streamed into the temp file.
3. On success, `IORenameFileTask` calls `osutil.rename_file(temp, final)` -- atomic on
   POSIX.
4. On failure, a cleanup callback calls `osutil.remove_file(temp)`.

From `s3transfer/utils.py`:

```python
def get_temp_filename(self, filename):
    suffix = os.extsep + random_file_extension()
    path = os.path.dirname(filename)
    name = os.path.basename(filename)
    temp_filename = name[:self._MAX_FILENAME_LEN - len(suffix)] + suffix
    return os.path.join(path, temp_filename)
```

**Interrupted download:** Target file is never left in a partial state.
A temp file with a random extension may remain, but the original file (if it existed) is
untouched. Re-running `aws s3 sync` detects the file still needs transfer and
re-downloads.

**Interrupted directory sync:** Each individual file is atomic, but the overall sync is
not transactional. Some files will be complete, others won’t have started.
Re-running picks up where it left off.

**References:**

- [aws-cli issue #701](https://github.com/aws/aws-cli/issues/701): Use temporary file
  name while file download in progress (resolved Jan 2017)
- [s3transfer/download.py](https://github.com/boto/s3transfer/blob/ccb71ddd89149a4bc5a45a2fcd5e42aafba3f0ea/s3transfer/download.py)

### rclone (`rclone copy` / `rclone sync`)

**Atomic by default (for local filesystem destinations).
Controllable via `--inplace` flag.**

When the destination is a local filesystem, rclone writes to a temporary file and
renames on completion:

1. Writes to `<filename>XXXXXX.partial` (where `XXXXXX` is derived from a hash of the
   source file’s fingerprint).
2. On success, renames `.partial` to final filename.
3. On failure, deletes the `.partial` file.

| Flag | Effect |
| --- | --- |
| (default) | Atomic: temp file + rename |
| `--inplace` | Non-atomic: writes directly to target. Faster but risks partial files. |
| `--partial-suffix <s>` | Customize the temp file suffix (default: `.partial`, max 16 chars) |

**Interrupted download:** Without `--inplace`, target file is never partial.
`.partial` temps may remain.

**Interrupted directory sync:** Same as AWS CLI -- per-file atomic, not transactional
across files.
Additionally, `rclone sync` will not delete destination files if any errors
occurred during the sync (safety mechanism).

**References:**

- [rclone docs: --inplace](https://rclone.org/docs/#inplace)
- [rclone docs: --partial-suffix](https://rclone.org/docs/#partial-suffix-string)

### AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`)

**Not atomic. Caller’s responsibility.**

`GetObjectCommand` returns a `ReadableStream` in the response `Body`. The SDK does not
manage local filesystem operations.
The typical usage pipes directly to the target path:

```typescript
const response = await client.send(new GetObjectCommand({ Bucket, Key }));
await pipeline(response.Body, createWriteStream("/path/to/file"));
```

This writes directly to the final path.
If the process is interrupted, you get a partial file at the destination.

**blobsy must implement atomic writes when using the built-in S3 transport.**

* * *

## Implications for blobsy

### What the design gets for free

When `sync.tool` is `aws-cli` or `rclone` (the first two options in the `auto`
resolution order), file writes are already atomic.
blobsy doesn’t need to wrap these tools with additional atomic-write logic.

This covers the majority of real-world usage, since `auto` prefers aws-cli and rclone
over built-in.

### What blobsy must handle itself

When `sync.tool` is `built-in` (the `@aws-sdk/client-s3` fallback), blobsy must
implement atomic writes:

1. Download to a temp file in the same directory as the target (e.g.,
   `file.parquet.blobsy-tmp-XXXXXX`).
2. On success, `fs.rename(temp, final)` (atomic on POSIX within the same filesystem).
3. On failure, `fs.unlink(temp)`.

The same-directory requirement is critical: `rename()` is only atomic within the same
filesystem mount point.
Writing to `/tmp` and then renaming to the target directory will fail if they’re on
different mounts.

### Manifest writes

Regardless of transport tool, blobsy writes manifests itself.
The remote manifest (`.blobsy-manifest.json`) should be written atomically:

- **Remote:** Upload the complete manifest as a single S3 PUT. S3 PUTs are atomic -- the
  object either exists in full or doesn’t. There is no risk of a partial manifest on S3.
- **Local:** If blobsy ever caches manifests locally, use temp file + rename.

### Pointer file writes

Pointer files (`.blobsy` files) are written by blobsy, not by the transport tool.
These should also use temp file + rename, since a partial `.blobsy` file would break
subsequent operations.

* * *

## Atomic Write Libraries for Node.js

For blobsy’s built-in transport path (and for writing pointer files and local
manifests), there are several options:

### [`write-file-atomic`](https://www.npmjs.com/package/write-file-atomic)

The most widely used package.
Used internally by npm itself.

- Creates a temp file with a murmur hash-based name in the same directory.
- Writes data, optionally sets ownership, then atomic `rename()`.
- On error, unlinks the temp file.
- Serializes concurrent writes to the same file automatically.
- Both async and sync APIs.

**Limitation:** Expects a complete buffer or string -- does not support streaming.
For pointer files and manifests (small, fully buffered), this is fine.

### [`atomically`](https://www.npmjs.com/package/atomically)

A rewrite of `write-file-atomic` with zero dependencies and slightly better performance.
Largely a drop-in replacement.

### Streaming Atomic Writes (Manual)

For downloading large files via the built-in S3 transport, where we need to stream
directly to disk without buffering the entire file in memory:

```typescript
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";

async function atomicStreamWrite(
  source: ReadableStream,
  targetPath: string,
): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tempPath = `${targetPath}.blobsy-tmp-${suffix}`;

  try {
    await pipeline(source, createWriteStream(tempPath));
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}
```

This follows the same pattern as AWS CLI and rclone:

- Temp file in the same directory (ensures same filesystem)
- Unique suffix to avoid collisions with parallel operations
- Cleanup on failure
- Atomic rename on success

No library needed -- the pattern is simple enough to implement directly.

* * *

## Summary of Guarantees by Transport

| Transport | Per-file atomic? | Who ensures it? | Interrupted state |
| --- | --- | --- | --- |
| `aws-cli` | Yes | AWS CLI (s3transfer) | Target untouched; temp file may remain |
| `rclone` | Yes (default) | rclone | Target untouched; `.partial` may remain |
| `rclone --inplace` | No | N/A | Target is partial |
| `built-in` | Must be implemented | blobsy | blobsy must use temp + rename |

| blobsy-written file | Atomic? | How? |
| --- | --- | --- |
| `.blobsy` pointer files | Should be | `write-file-atomic` or manual temp + rename |
| Remote manifests | Yes (inherent) | S3 PUT is atomic |
| Local manifest cache | Should be | `write-file-atomic` or manual temp + rename |

### Design Recommendations

1. **Document that aws-cli and rclone provide per-file atomic writes by default.** This
   is a key reason the design’s delegation model works well -- the common transports
   already do the right thing.

2. **Implement atomic writes in the built-in transport path.** Use the streaming temp +
   rename pattern above.
   Use a recognizable prefix (e.g., `.blobsy-tmp-`) so stale temp files from interrupted
   operations can be identified and cleaned up.

3. **Use `write-file-atomic` (or equivalent) for all blobsy-written files:** pointer
   files, local config updates, any local manifest cache.

4. **Do not add an `--inplace` flag to blobsy.** The atomicity guarantee should be
   unconditional. Users who want non-atomic rclone behavior can set
   `sync.extra_flags: "--inplace"` in config, but blobsy shouldn’t encourage it.

5. **Add a `blobsy clean` or cleanup mechanism** that removes stale `.blobsy-tmp-*`
   files left behind by interrupted operations.
   Or simply: on push/pull startup, remove any existing `.blobsy-tmp-*` files in target
   directories before beginning.

6. **Note that per-file atomicity does not give transactional sync.** If a directory
   push/pull is interrupted, some files will be complete and others won’t. This is fine
   -- re-running the operation is idempotent and picks up where it left off.
   The remote manifest is written last (after all files are uploaded), so an interrupted
   push never leaves a manifest that references files that weren’t fully uploaded.
