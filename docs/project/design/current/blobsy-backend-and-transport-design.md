# Blobsy: Backend and Transport Layer Design

**Date:** 2026-02-21

**Status:** Draft

This document covers how blobs are stored, transferred, and validated on the backend.
See also [blobsy-design.md](blobsy-design.md) for the overall design (ref files, state
model, CLI commands).

**Contract with the frontend:** The frontend (CLI commands, stat cache, conflict
detection) interacts with the backend through a simple interface: push a blob by local
path + remote key, pull a blob by remote key + local path.
The backend handles tool selection, authentication, error formatting, health checks, and
atomic writes. The frontend never talks directly to S3, rclone, or any transport tool.

## Backend Types

**`s3`:** Any S3-compatible store.
This single type covers AWS S3, Cloudflare R2, MinIO, Backblaze B2, Tigris, DigitalOcean
Spaces, and others.
R2 and other S3-compatible stores are configured as `type: s3` with a
custom `endpoint`.

**`local`:** Directory-to-directory copy.
For development and testing.
No cloud account needed.

**`command`:** Arbitrary shell commands for push/pull.
This serves two purposes:

1. **Escape hatch** for unsupported backends (SCP, rsync, custom APIs).
2. **Template-based transfer layer** -- a powerful alternative to named tools.
   Because each command template runs once per file with variable expansion, a `command`
   backend is functionally equivalent to a custom transfer tool.

Template variables:

- `{local}` -- absolute path to the local file.
- `{remote}` -- full remote key (e.g., `sha256/7a3f0e.../data/prices.parquet`).
- `{relative_path}` -- repo-relative path of the tracked file (e.g.,
  `data/prices.parquet`).
- `{bucket}` -- the configured bucket name.

The command runs once per file (not once per push operation), with up to `sync.parallel`
invocations running concurrently.

**Error handling:**
- **Exit code 0:** Success - file transferred successfully
- **Non-zero exit code:** Failure - file transfer failed

On failure, blobsy captures **both stdout and stderr** from the command and displays
them to the user with context (file path, command, exit code).
Transport tools vary in where they write error messages -- some use stderr, some use
stdout, some use both.
Blobsy does not discard either stream.

**Examples:**

```yaml
backends:
  # SCP to a remote server
  ssh-server:
    type: command
    push_command: scp {local} myhost:/data/{remote}
    pull_command: scp myhost:/data/{remote} {local}

  # rsync with compression
  rsync-remote:
    type: command
    push_command: rsync -az {local} myhost:/data/{remote}
    pull_command: rsync -az myhost:/data/{remote} {local}

  # curl to a custom HTTP API
  custom-api:
    type: command
    push_command: >-
      curl -sf -X PUT -T {local}
      https://api.example.com/blobs/{remote}
    pull_command: >-
      curl -sf -o {local}
      https://api.example.com/blobs/{remote}

  # aws-cli with custom flags (e.g., specific profile, storage class)
  s3-archive:
    type: command
    push_command: >-
      aws s3 cp {local} s3://my-archive-bucket/{remote}
      --profile archive --storage-class GLACIER_IR
    pull_command: >-
      aws s3 cp s3://my-archive-bucket/{remote} {local}
      --profile archive
```

This design means that even without first-class support for a given transfer tool or
storage backend, a user can integrate it in minutes with a template command.
The `command` backend is sufficient for any tool that can copy a single file given a
source and destination path.

**Security restriction:** `command` backends from repo-level config require explicit
trust. See the Security and Trust Model section in the
[main design](blobsy-design.md#security-and-trust-model).

**Cross-platform limitations:** Command backends run through Node.js `child_process`,
which uses different shells on different platforms (cmd.exe on Windows, /bin/sh on
Unix). For cross-platform compatibility in mixed OS environments, avoid complex shell
pipes, operators, or bash-specific syntax.
Instead, use simple command invocations or prefer named tools (`aws-cli`, `rclone`) that
have cross-platform installers and consistent CLI interfaces.
If shell-specific features are needed, consider maintaining separate `.blobsy.yml` files
with platform-specific commands or using the `s3` backend type with named transfer
tools.

## S3-Compatible Backends

R2, MinIO, Backblaze B2, Tigris, and other S3-compatible stores all use the same
`type: s3` backend with a custom endpoint:

```yaml
backends:
  r2:
    type: s3
    endpoint: https://ACCT_ID.r2.cloudflarestorage.com
    bucket: my-r2-data

  dev:
    type: local
    path: /tmp/blobsy-test-remote/
```

The AWS CLI and rclone support `--endpoint-url` for S3-compatible stores.
`@aws-sdk/client-s3` supports custom endpoints via its client configuration object.

## Transfer Delegation

`blobsy` does not implement high-performance transfers.
It delegates to external CLI tools, trying each in the configured preference order:

| Tool | How transfers work |
| --- | --- |
| `aws-cli` | Shells out to `aws s3 cp` per file |
| `rclone` | Shells out to `rclone copyto` per file |

The `sync.tools` setting is an ordered list (default: `[aws-cli, rclone]`). Blobsy tries
each tool in order, using the first one that passes a capability check.
To force a specific tool, set a single-element list: `sync.tools: [rclone]`. This
setting follows the standard hierarchical config override (user-global < repo <
directory), so a user who prefers rclone can set it globally while repos can override if
needed.

Because blobsy uses content-addressable storage and per-file `.yref` refs, it always
knows exactly which files to transfer.
It uses transfer tools as **copy engines** (per-file `cp`/`copy`), not diff engines.
Blobsy owns the diffing via `.yref` hashes; the transfer tool only moves bytes.

**Tool detection:** Blobsy performs a lightweight capability check (binary exists +
credentials configured + endpoint reachable), not just binary existence.
If aws-cli is installed but not configured for the target endpoint, it falls through to
the next tool in the list.
`blobsy doctor` shows which tool was selected and why.

**Template commands as transfer layer:** For backends that are not S3-compatible, or for
advanced use cases (SCP, custom APIs, proprietary tools), the `command` backend type
doubles as a fully custom transfer layer.
Because the command template runs once per file with `{local}` and `{remote}` variable
expansion, it is functionally equivalent to a transfer tool -- just specified as a
template rather than a named preset.
See [Backend Types](#backend-types) for details.

This means blobsy supports three transfer modes in the initial release:
1. **Named tools** (`aws-cli`, `rclone`) -- zero-config for S3-compatible backends.
2. **Template commands** (`command` backend) -- arbitrary CLI commands, one per file.
   Works with SCP, rsync, curl, or any tool that can copy a file.
3. **Built-in SDK** (`@aws-sdk/client-s3`) -- fallback when no external tool is
   available. Slower, but zero external dependencies.

## Compression and Transfer Interaction

Compression is handled by blobsy, not by the transfer tool.
The workflow for each file:

**Push:** compress to temp file (if compression applies) -> upload via transfer tool ->
clean up temp file.

**Pull:** download via transfer tool -> decompress from temp file (if compressed) ->
write to final location.

This is file-by-file orchestration.
Blobsy never delegates directory-level `sync` to external tools because the remote
representation (compressed, content-addressed) differs from the local representation
(uncompressed, original paths).

## Symlinks

`blobsy` inherits symlink behavior from the underlying transport tool.
Symlinks are followed on push (the content is uploaded), and regular files are written
on pull (S3 and other object stores have no symlink concept).
Symlink metadata is not preserved across the remote.

## Authentication

No custom auth mechanism.
Uses the standard credential chain for the backend:

- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Shared credentials file (`~/.aws/credentials`)
- Instance profiles / IAM roles
- rclone config (when rclone is selected from `sync.tools`)

## Atomic Writes

**All backends:** Blobsy manages atomic downloads for ALL backends to ensure consistent,
reliable behavior regardless of the underlying transport mechanism.
We do not rely on external tools to handle atomicity.

**Download pattern for all backends:**

1. Download to blobsy-managed temp file (`.blobsy-tmp-*` pattern)
2. Compute SHA-256 hash and verify integrity
3. Atomically rename to final location only after successful verification

**Backend-specific implementation:**

- **Built-in `@aws-sdk` engine:** Blobsy downloads directly to temp file, then renames
- **External tools (aws-cli, rclone):** Blobsy wraps tool invocation to download to temp
  file first, then verifies and renames
- **Command backends:** Blobsy provides `$BLOBSY_TEMP_OUT` environment variable pointing
  to temp file location; user templates write there; blobsy verifies hash and renames on
  exit code 0

**Other atomic operations:** Blobsy also uses temp-file-then-rename for:

- `.yref` file updates
- Stat cache writes (file-per-entry, via `atomically` package)

**Temp file management:**

- Temp files use the pattern `.blobsy-tmp-*` in the same directory as the target file
- `blobsy doctor` reports orphaned temp files
- On startup or via `blobsy clean`, orphaned temp files are removed

**Interrupted operations:** If push or pull is interrupted midway, re-running is safe.
Already-transferred files are detected via hash comparison and skipped.
Per-file atomicity ensures no corrupt partial files.

## Error Handling

When transport commands fail, blobsy provides clear, actionable error messages with full
diagnostic context. This is critical for debugging common issues like authentication
failures, permission errors, and network problems.

### Error Capture

When a transport command fails (non-zero exit code):

1. **Capture both stdout and stderr** from the failed command
2. **Preserve the original error message** from the transport tool
3. **Add context** about which file transfer failed and what command was attempted
4. **Format consistently** across all backends (S3, local, command templates)

**Important:** Both stdout and stderr are captured.
Transport tools vary in where they write error messages -- aws-cli may write JSON errors
to stdout, rclone writes to stderr, custom scripts may use either.
Blobsy does not assume or discard either stream.

### Error Message Format

**Human-readable format (default):**

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 1

Output:
upload failed: s3://my-bucket/sha256/abc123... An error occurred (InvalidAccessKeyId)
when calling the PutObject operation: The AWS Access Key Id you provided does not
exist in our records.

Troubleshooting:
- Check AWS credentials: aws configure list
- Verify bucket access: aws s3 ls s3://my-bucket/
- See: https://github.com/jlevy/blobsy/docs/troubleshooting#auth-errors
```

**JSON format (`--json`):**

```json
{
  "schema_version": "0.1",
  "error": {
    "type": "transport_failure",
    "file": "data/model.bin",
    "size": 524288000,
    "direction": "push",
    "backend": "s3",
    "bucket": "my-bucket",
    "remote_key": "sha256/abc123...",
    "command": "aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...",
    "exit_code": 1,
    "stdout": "upload failed: s3://my-bucket/sha256/abc123...",
    "stderr": "An error occurred (InvalidAccessKeyId) when calling the PutObject operation: The AWS Access Key Id you provided does not exist in our records.",
    "error_category": "authentication",
    "troubleshooting_url": "https://github.com/jlevy/blobsy/docs/troubleshooting#auth-errors"
  }
}
```

### Error Categories

Blobsy attempts to categorize common transport errors for better troubleshooting:

| Category | Detection Patterns | Common Causes |
| --- | --- | --- |
| `authentication` | “InvalidAccessKeyId”, “AccessDenied”, “403”, “Forbidden” | Missing/expired credentials, wrong IAM permissions |
| `not_found` | “NoSuchBucket”, “404”, “Not Found”, “NoSuchKey” | Bucket doesn’t exist, wrong region, blob not found |
| `network` | “Connection refused”, “timeout”, “Name resolution failed” | Network down, DNS issues, firewall blocking |
| `permission` | “Permission denied”, “Access Denied”, “InsufficientPermissions” | IAM policy missing required actions |
| `quota` | “RequestLimitExceeded”, “TooManyRequests”, “429” | Rate limiting, quota exceeded |
| `storage_full` | “No space left”, “QuotaExceeded”, “InsufficientStorage” | Bucket quota exceeded, local disk full |
| `unknown` | (default) | Unrecognized error pattern |

Error categorization is best-effort pattern matching on stdout/stderr.
It enables context-aware troubleshooting suggestions.

### Partial Failure Handling

When syncing multiple files, blobsy continues processing remaining files after a
transport failure:

```bash
$ blobsy push
Pushing 3 files...
  ✓ data/file1.bin (1.2 GB) - ok
  ✗ data/file2.bin (500 MB) - FAILED
  ✓ data/file3.bin (800 MB) - ok

1 file failed (see errors above)
Exit code: 1
```

All errors are collected and displayed at the end.
Exit code is 1 if any file failed.

In `--json` mode, the output includes both successful and failed transfers:

```json
{
  "schema_version": "0.1",
  "summary": {
    "total": 3,
    "succeeded": 2,
    "failed": 1
  },
  "transfers": [
    {"file": "data/file1.bin", "status": "success", "size": 1288490188},
    {
      "file": "data/file2.bin",
      "status": "failed",
      "error": {
        "type": "transport_failure",
        "command": "aws s3 cp ...",
        "exit_code": 1,
        "stdout": "...",
        "stderr": "...",
        "error_category": "authentication"
      }
    },
    {"file": "data/file3.bin", "status": "success", "size": 838860800}
  ]
}
```

### Common Error Scenarios

These scenarios must be tested (see the Testing section in the
[main design](blobsy-design.md#testing)) and should produce helpful error messages:

#### Missing AWS Credentials

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 255

Output:
Unable to locate credentials. You can configure credentials by running "aws configure".

Troubleshooting:
- Run: aws configure
- Or set: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
- Or use IAM role (if on EC2/ECS)
- See: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
```

#### Wrong Bucket/Region

```
Error: Failed to pull data/model.bin (500 MB)

Command: aws s3 cp s3://my-bucket/sha256/abc123... /path/to/data/model.bin
Exit code: 1

Output:
fatal error: An error occurred (NoSuchBucket) when calling the HeadObject operation:
The specified bucket does not exist

Troubleshooting:
- Verify bucket name: my-bucket
- Check region: us-east-1 (configured) vs. actual bucket region
- Run: aws s3 ls s3://my-bucket/ --region us-east-1
- Check .blobsy.yml backend configuration
```

#### Permission Denied

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 1

Output:
upload failed: s3://my-bucket/sha256/abc123... An error occurred (AccessDenied) when
calling the PutObject operation: Access Denied

Troubleshooting:
- Your IAM user/role needs s3:PutObject permission on s3://my-bucket/*
- Check IAM policy attached to your credentials
- See: https://github.com/jlevy/blobsy/docs/troubleshooting#iam-permissions
```

#### Network Timeout

```
Error: Failed to push data/model.bin (500 MB)

Command: aws s3 cp /path/to/data/model.bin s3://my-bucket/sha256/abc123...
Exit code: 1

Output:
upload failed: s3://my-bucket/sha256/abc123... Connect timeout on endpoint URL:
"https://my-bucket.s3.amazonaws.com/..."

Troubleshooting:
- Check network connectivity
- Verify firewall/proxy settings
- Try with smaller file first to test connectivity
- Consider increasing timeout: AWS_CLI_CONNECT_TIMEOUT=60
```

#### Disk Full (Local)

```
Error: Failed to pull data/model.bin (500 MB)

Command: aws s3 cp s3://my-bucket/sha256/abc123... /path/to/data/model.bin
Exit code: 1

Output:
download failed: [Errno 28] No space left on device: '/path/to/data/model.bin'

Troubleshooting:
- Free up disk space on local filesystem
- Current usage: df -h /path/to/data
- Consider using blobsy rm --local to remove other tracked files
```

## Health Check

Before starting concurrent file transfers, blobsy runs a lightweight health check to
verify the transport backend is accessible and credentials are valid.
This **fails fast** with a clear error message instead of spawning multiple failing
concurrent processes.

**Why this matters:**

Without a health check, syncing 100 files with invalid credentials would spawn up to
`sync.parallel` (default 8) concurrent failed transfers, producing 8 identical error
messages simultaneously.
This is confusing and wasteful.

With a health check, blobsy detects the auth problem immediately and shows one clear
error before attempting any transfers.

**Health check per backend:**

| Backend | Health Check Operation | What It Validates |
| --- | --- | --- |
| `s3` | `HeadBucket` or small `ListObjectsV2` (1 item) | Credentials valid, bucket exists, region correct, network reachable |
| `local` | `stat()` on the target directory | Directory exists and is writable |
| `command` | Run push_command with a tiny test file (writes + deletes 1 KB test object) | Command syntax valid, remote accessible, credentials work |

**Health check is:**
- **Fast** - single lightweight operation (< 1 second in normal cases)
- **Skippable** - `--skip-health-check` flag for advanced users who know backend is
  healthy
- **Cached** - health check result cached for 60 seconds to avoid redundant checks
  across multiple sync commands

**Failure modes:**

```bash
$ blobsy push
Checking backend health...
✗ Backend health check failed

Error: Cannot access s3://my-bucket/
Command: aws s3api head-bucket --bucket my-bucket
Exit code: 254

Output:
An error occurred (NoSuchBucket) when calling the HeadBucket operation: The specified
bucket does not exist

Troubleshooting:
- Verify bucket name: my-bucket
- Check region in .blobsy.yml: us-east-1
- Run: aws s3 ls s3://my-bucket/ --region us-east-1
- See: https://github.com/jlevy/blobsy/docs/troubleshooting#bucket-config

Aborting sync. Fix backend configuration and try again.
```

**Success (normal case):**

```bash
$ blobsy push
✓ Backend healthy (s3://my-bucket/)
Pushing 42 files...
  ✓ data/file1.bin (1.2 GB) - ok
  ✓ data/file2.bin (500 MB) - ok
  ...
```

**Exposed as `blobsy health` command:**

Health checks are also exposed as a standalone command for troubleshooting:

```bash
$ blobsy health
Checking transport backend health...

Backend: s3
  Bucket: my-bucket
  Region: us-east-1
  Prefix: project-v1/

✓ Credentials valid (AWS profile: default)
✓ Bucket accessible
✓ Can write (test upload: 1 KB)
✓ Can read (test download: 1 KB)
✓ Can delete (cleaned up test object)

Transfer tools:
  ✓ aws-cli v2.13.5 (using this)
  ✗ rclone (not installed)

All checks passed. Backend is healthy.
```

With `--json`:

```json
{
  "schema_version": "0.1",
  "backend": {
    "type": "s3",
    "bucket": "my-bucket",
    "region": "us-east-1",
    "prefix": "project-v1/"
  },
  "health_checks": {
    "credentials": {"status": "ok", "message": "AWS profile: default"},
    "bucket_access": {"status": "ok", "message": "Bucket accessible"},
    "can_write": {"status": "ok", "message": "Test upload: 1 KB"},
    "can_read": {"status": "ok", "message": "Test download: 1 KB"},
    "can_delete": {"status": "ok", "message": "Cleaned up test object"}
  },
  "transfer_tools": {
    "selected": "aws-cli",
    "aws-cli": {"available": true, "version": "2.13.5"},
    "rclone": {"available": false, "error": "not found in PATH"}
  },
  "overall_status": "healthy"
}
```

**Integration with `blobsy doctor`:**

`blobsy doctor` includes health check results in its comprehensive diagnostics (see
`blobsy doctor` command documentation in the [main design](blobsy-design.md)).

**Implementation note:**

Health checks are implemented in the initial release for S3 and local backends.
Command backends skip health checks in the initial release (deferred to a future
version) since arbitrary commands may not have a safe, side-effect-free health check
operation.
