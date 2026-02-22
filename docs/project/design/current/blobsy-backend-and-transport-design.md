# Blobsy: Backend and Transport Layer Design

**Date:** 2026-02-21

**Status:** Draft

* * *
**V1 Implementation Scope:**

✅ **Implemented in V1.0:**
- S3 backend via built-in `@aws-sdk/client-s3` (native TypeScript implementation)
- Local filesystem backend

⏸️ **Deferred to V1.1+:**
- Transfer tool delegation (aws-cli, rclone, s5cmd) - fully designed but not implemented
- GCS backend (`gs://`)
- Azure Blob Storage backend (`az://`)

V1.0 ships with robust S3 and local support.
Tool delegation and additional cloud providers are planned for V1.1. See
[issues-history.md](issues-history.md) for implementation rationale.

* * *

This document covers how blobs are stored, transferred, and validated on the backend.
See also [blobsy-design.md](blobsy-design.md) for the overall design (ref files, state
model, CLI commands).

**Contract with the frontend:** The frontend (CLI commands, stat cache, conflict
detection) interacts with the backend through a simple interface: push a blob by local
path + remote key, pull a blob by remote key + local path.
The backend handles tool selection, authentication, error formatting, health checks, and
atomic writes. The frontend never talks directly to S3, rclone, or any transport tool.

## Backend URL Convention

Backends are identified by a URL. The URL scheme determines the backend type, and the
path encodes bucket/container and prefix.
This follows the same convention used by DVC, rclone, AWS CLI, gsutil, and other data
tools.

### Supported URL Schemes

| Scheme | Backend type | URL format | Example |
| --- | --- | --- | --- |
| `s3://` | `s3` | `s3://<bucket>/<prefix>` | `s3://my-datasets/project-v1/` |
| `gs://` | `gcs` | `gs://<bucket>/<prefix>` | `gs://my-data/prefix/` |
| `azure://` | `azure` | `azure://<container>/<prefix>` | `azure://mycontainer/blobs/` |
| `local:` | `local` | `local:<path>` | `local:../blobsy-remote`, `local:/tmp/blobsy-store` |

Every backend has an explicit scheme.
There are no bare paths -- `local:` is required for local directory backends.
This avoids ambiguity (a path argument to `init` could be mistaken for something else)
and makes it clear that the target is a directory used as a blob store, not something
inside the repo.

The URL is the primary way to specify a backend on the CLI and in config.
Blobsy parses the scheme to determine the backend type, the authority/host to determine
the bucket or container, and the path to determine the directory or prefix.

### Precedent: How Other Tools Handle This

| Tool | S3 | GCS | Azure | Local |
| --- | --- | --- | --- | --- |
| DVC | `s3://bucket/path` | `gs://bucket/path` | `azure://container/path` | `/path` (bare) |
| rclone | `remote:bucket/path` | `remote:bucket/path` | `remote:container/path` | `/path` (bare) |
| AWS CLI | `s3://bucket/key` | -- | -- | -- |
| gsutil/gcloud | -- | `gs://bucket/path` | -- | -- |

DVC and rclone use bare paths for local remotes.
Blobsy uses `local:` instead because:

1. **Clarity.** `blobsy init local:../blobsy-remote` is unambiguous.
   A bare `./remote` argument to `init` could be mistaken for a repo-relative path or
   config file.
2. **Validation.** The `local:` prefix signals “this is a directory backend” and
   triggers directory-specific validation (must be a directory, not a file; parent must
   exist).
3. **Consistency.** Every backend type has a scheme.
   No special-casing for “no scheme means local.”

### URL Parsing Rules

The URL is parsed as follows:

| URL | Parsed type | Parsed bucket/container | Parsed prefix/path |
| --- | --- | --- | --- |
| `s3://my-bucket/project-v1/` | `s3` | `my-bucket` | `project-v1/` |
| `s3://my-bucket/a/b/c/` | `s3` | `my-bucket` | `a/b/c/` |
| `gs://my-bucket/prefix/` | `gcs` | `my-bucket` | `prefix/` |
| `azure://mycontainer/blobs/` | `azure` | `mycontainer` | `blobs/` |
| `s3://my-bucket` | **error** | -- | -- |
| `local:/tmp/blobsy-remote` | `local` | -- | `/tmp/blobsy-remote` |
| `local:../blobsy-remote` | `local` | -- | `./remote` |
| `local:../shared-store` | `local` | -- | `../shared-store` |
| `local:~/blobsy-data` | `local` | -- | `~/blobsy-data` (expanded) |

For cloud schemes (`s3://`, `gs://`, `azure://`), a prefix is **required**. A URL with
only a bucket and no prefix (e.g. `s3://my-bucket`) is rejected:

```
Error: Missing prefix in URL: "s3://my-bucket"

A prefix is required to avoid writing blobs to the root of the bucket.
Add a prefix path after the bucket name:
  blobsy init s3://my-bucket/my-project/
```

A trailing slash on the prefix is optional and normalized (blobsy always appends one
internally).

For `local:`, the path after the colon is the directory path.
It can be absolute, relative, or home-relative (`~`).

**Relative paths are always relative to the git repo root** (the directory containing
`.git/`), not relative to the current working directory or to `.blobsy.yml`. This is the
same convention Git uses for `.gitignore` patterns and submodule paths.
The path is stored as-is in `.blobsy.yml` and resolved against the repo root at runtime.
This means `local:../blobsy-remote` always refers to `<repo-root>/../blobsy-remote/`
regardless of where `blobsy` is invoked from within the repo.

Rationale: making paths repo-root-relative avoids surprises when running blobsy from
subdirectories. If `local:../blobsy-remote` meant “relative to cwd,” the same config
would resolve to different directories depending on where the user runs the command.

**The resolved path must be outside the repo root.** A local backend path that resolves
to a directory inside the git repository is rejected.
Storing blobs inside the repo would cause git to track them (bloating the repo), and
blobsy could recursively encounter its own store.
Use `../` to place the backend alongside the repo, or use an absolute path.

```
Error: Local backend path is inside the git repository

  Resolved path: /Users/alice/projects/ml-research/remote
  Repository root: /Users/alice/projects/ml-research

The local backend directory must be outside the git repo to avoid
git tracking blob files. Use a path outside the repo:
  blobsy init local:../blobsy-remote
  blobsy init local:/tmp/blobsy-remote
```

### URL Validation

Blobsy validates backend URLs strictly.
Unrecognized schemes are rejected at parse time with a clear error, not silently
accepted.

**Scheme recognition:**

Blobsy recognizes exactly these URL forms:

| Input pattern | Recognized as | Notes |
| --- | --- | --- |
| `s3://...` | S3 backend | Case-insensitive scheme matching |
| `gs://...` | GCS backend |  |
| `azure://...` | Azure backend |  |
| `local:...` | Local directory | Path after colon; absolute, relative, or `~` |

Anything else -- `http://`, `ftp://`, `hdfs://`, `r2://`, `file://`, a bare path like
`./remote`, or a bare word like `mybucket` -- is rejected:

```
Error: Unrecognized backend URL: "r2://my-bucket/prefix/"

Supported URL schemes:
  s3://bucket/prefix/       Amazon S3 and S3-compatible (R2, MinIO, B2, etc.)
  gs://bucket/prefix/       Google Cloud Storage
  azure://container/prefix/ Azure Blob Storage
  local:path                Local directory

For S3-compatible stores like R2, use s3:// with --endpoint:
  blobsy init s3://my-bucket/blobs/ --endpoint https://ACCT_ID.r2.cloudflarestorage.com

For local directories:
  blobsy init local:../blobsy-remote
  blobsy init local:/tmp/blobsy-store
```

Bare paths are explicitly rejected with a hint to use `local:`:

```
Error: Unrecognized backend URL: "./remote"

Did you mean a local directory backend?
  blobsy init local:../blobsy-remote
```

**Per-scheme validation rules:**

| Scheme | Validation | Error on failure |
| --- | --- | --- |
| `s3://` | Must have non-empty bucket name (the host component). Bucket must match S3 naming rules: 3-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen, no `..`. Must have a non-empty prefix (path after bucket). Prefix must not contain `//` or backslashes. | `Invalid S3 URL: bucket name "AB" is invalid (must be 3-63 lowercase chars)` or `Missing prefix in URL: "s3://my-bucket"` |
| `gs://` | Must have non-empty bucket name. Bucket: 3-63 chars, lowercase alphanumeric + hyphens + dots, no leading/trailing dot/hyphen. Must have a non-empty prefix. No `//` in path. | `Invalid GCS URL: missing bucket name` or `Missing prefix in URL: "gs://my-bucket"` |
| `azure://` | Must have non-empty container name. Container: 3-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen. Must have a non-empty prefix. No `//` in path. | `Invalid Azure URL: container name "--bad" starts with hyphen` or `Missing prefix in URL: "azure://mycontainer"` |
| `local:` | Path after colon must not be empty. Must not contain null bytes. Must resolve to a directory (not a file). Relative paths are relative to git repo root. Resolved absolute path must be outside the repo root. At runtime, target directory must exist (or is created by the first push). | `Invalid local URL: path is empty (use local:../blobsy-remote)` or `Local backend path is inside the git repository` |

**S3 bucket naming rules** (per
[AWS S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html)):

- 3 to 63 characters
- Lowercase letters, numbers, hyphens only
- Must start and end with a letter or number
- No consecutive periods (`..`)
- Must not be formatted as an IP address (`192.168.1.1`)

Blobsy enforces these at URL parse time so that typos like `s3://My-Bucket` or `s3://ab`
are caught immediately with a specific message, not deferred to a cryptic AWS API error.

**Prefix validation (all cloud schemes):**

- Must not be empty (writing blobs to bucket root is disallowed)
- Must not start with `/` (the scheme already separates bucket from prefix)
- Must not contain `//` (likely a typo)
- Must not contain `\` (not valid in object keys)
- Must not contain null bytes or control characters

**Query parameters and fragments:**

URLs must not contain query strings (`?key=value`) or fragments (`#section`). These are
not meaningful for blob storage URLs and indicate a likely mistake:

```
Error: Unexpected query string in URL: "s3://bucket/prefix/?region=us-east-1"

Region should be specified as a flag:
  blobsy init s3://bucket/prefix/ --region us-east-1
```

**Flag compatibility checks:**

After URL parsing, blobsy validates that flags are compatible with the parsed backend
type:

| Flag | Valid with | Error if used with |
| --- | --- | --- |
| `--region` | `s3` | `local`, `gcs`, `azure` |
| `--endpoint` | `s3` | `local`, `gcs`, `azure` |

```
Error: --region is not applicable to local backends

  blobsy init local:/tmp/remote --region us-east-1
                                ^^^^^^^^^^^^^^^^^^
```

**Config file validation:**

The same validation runs when loading `.blobsy.yml`. Invalid URLs in config produce the
same clear errors, with the added context of which config file and which backend name
contains the problem:

```
Error: Invalid backend URL in .blobsy.yml (backends.default.url)

  url: "s3://AB/prefix/"

  S3 bucket name "AB" is too short (minimum 3 characters).
```

### CLI Usage

```bash
# S3
blobsy init s3://my-datasets/project-v1/ --region us-east-1

# S3-compatible (R2, MinIO, etc.)
blobsy init s3://my-r2-data/project/ --endpoint https://ACCT_ID.r2.cloudflarestorage.com

# GCS (future)
blobsy init gs://my-bucket/prefix/

# Azure (future)
blobsy init azure://mycontainer/blobs/

# Local (relative to repo root)
blobsy init local:../blobsy-remote

# Local (absolute)
blobsy init local:/tmp/blobsy-store

# Subsequent runs (config exists) -- no URL needed
blobsy init
```

The URL is a positional argument.
Additional backend-specific parameters are flags:

| Flag | Applies to | Description |
| --- | --- | --- |
| `--region <region>` | `s3` | AWS region (or S3-compatible region) |
| `--endpoint <url>` | `s3` | Custom S3-compatible endpoint URL |

On first run without a URL, `blobsy init` prints a usage error with examples (not a
prompt).

### Config File Format

The URL is stored in `.blobsy.yml` as a `url` field.
Additional parameters sit alongside it:

```yaml
# S3 backend
backends:
  default:
    url: s3://my-datasets/project-v1/
    region: us-east-1

# S3-compatible (R2)
backends:
  default:
    url: s3://my-r2-data/blobs/
    endpoint: https://ACCT_ID.r2.cloudflarestorage.com

# Local backend
backends:
  default:
    url: local:../blobsy-remote
```

The `url` field replaces the previous `type`, `bucket`, `path`, and `prefix` fields.
Blobsy derives all of those from the URL at parse time.
This is a simpler, more readable format that matches what users see in error messages,
health output, and status displays.

### What the URL Does NOT Encode

Some parameters don’t fit in a URL and remain as separate config fields or flags:

- **Region** -- not part of the S3 URI convention (AWS CLI also takes `--region`
  separately). DVC handles this the same way:
  `dvc remote modify myremote region us-east-2`.
- **Endpoint** -- for S3-compatible stores, the endpoint is a separate HTTPS URL, not
  part of the `s3://` path.
  DVC: `dvc remote modify myremote endpointurl https://...`.
- **Credentials** -- never in the URL. Uses standard credential chains (AWS profiles,
  env vars, IAM roles, Azure CLI, gcloud CLI).
- **Command templates** -- no URI representation.
  Command backends are configured with explicit `push_command` / `pull_command` fields
  (see below).

### Display Convention

The URL is the canonical way blobsy refers to a backend in output:

```
✓ Backend reachable (s3://my-datasets/project-v1/)
✗ Backend unreachable (local:../blobsy-remote)
```

## Backend Types

**`s3`:** Any S3-compatible store.
This single type covers AWS S3, Cloudflare R2, MinIO, Backblaze B2, Tigris, DigitalOcean
Spaces, and others. R2 and other S3-compatible stores use `s3://` URLs with a separate
`--endpoint` flag.

**`gcs`:** Google Cloud Storage.
Uses `gs://` URLs. Deferred to a future version (after Phase 1).

**`azure`:** Azure Blob Storage.
Uses `azure://` URLs following DVC’s convention.
Deferred to a future version.

**`local`:** Directory-to-directory copy.
For development and testing.
No cloud account needed.
Specified as `local:<path>` (e.g. `local:../blobsy-remote`).

**`command`:** Arbitrary shell commands for push/pull.
This serves two purposes:

1. **Escape hatch** for unsupported backends (SCP, rsync, custom APIs).
2. **Template-based transfer layer** -- a powerful alternative to named tools.
   Because each command template runs once per file with variable expansion, a `command`
   backend is functionally equivalent to a custom transfer tool.

Command backends have no URL. They are configured with explicit fields:

```yaml
backends:
  my-scp:
    type: command
    push_command: scp {local} myhost:/data/{remote}
    pull_command: scp myhost:/data/{remote} {local}
```

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

**More command backend examples:**

```yaml
backends:
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

**Security:** Command execution uses a shell-free model with strict character
validation. See the Security Model section in the
[main design](blobsy-design.md#security-model).

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

R2, MinIO, Backblaze B2, Tigris, and other S3-compatible stores all use `s3://` URLs
with a custom endpoint:

```yaml
backends:
  r2:
    url: s3://my-r2-data/blobs/
    endpoint: https://ACCT_ID.r2.cloudflarestorage.com

  dev:
    url: local:../blobsy-remote
```

The AWS CLI and rclone support `--endpoint-url` for S3-compatible stores.
`@aws-sdk/client-s3` supports custom endpoints via its client configuration object.

> **🚧 V1.1 Feature - Not Implemented in V1.0**
> 
> The transfer tool delegation system described in this section is fully designed but
> deferred to V1.1. V1.0 uses built-in `@aws-sdk/client-s3` for all S3 operations.
> 
> Reason for deferral: Built-in SDK provides better error handling, progress reporting,
> and cross-platform consistency.
> External tools add complexity without significant benefit for V1 use cases.

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

Because blobsy uses content-addressable storage and per-file `.bref` refs, it always
knows exactly which files to transfer.
It uses transfer tools as **copy engines** (per-file `cp`/`copy`), not diff engines.
Blobsy owns the diffing via `.bref` hashes; the transfer tool only moves bytes.

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

**V1 Implementation Note:**

In V1, all S3 transfers use the built-in SDK (`@aws-sdk/client-s3`). The `sync.tools`
config option is accepted but ignored.
Setting it to `["aws-cli"]` or `["rclone"]` will log a warning:

```
Warning: sync.tools is set to ["aws-cli"] but tool delegation is not implemented in V1.0.
Using built-in S3 SDK. Tool delegation will be available in V1.1.
```

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

## Atomic Operations

Blobsy ensures atomicity for all file operations (both reads and writes) to prevent
corruption and inconsistent state.

### Atomic .bref Updates (Push)

When `blobsy push` updates a `.bref` file, it uses **temp-file-then-rename** pattern:

1. Compute new `.bref` content (hash, size, remote_key, compressed fields)
2. Write to temporary file `.bref.tmp-{random}`
3. `fsync()` to ensure data reaches disk
4. Atomically rename `.bref.tmp-{random}` → `.bref`

**Atomicity guarantee:** The `.bref` file is never in a partially-written state.
Either the old version exists, or the new version exists — no intermediate state.

**Implementation:** `packages/blobsy/src/ref.ts:67-81` (uses `atomically` package)

### Atomic Remote Blob Writes (Push)

For S3 backends, blob uploads are atomic because S3 `PutObject` is atomic:
- Object appears at key only after complete upload
- Failed uploads leave no partial object
- No temp file needed (S3 handles atomicity)

For local backends, same temp-file-then-rename pattern as .bref files:
1. Write to `.blobsy/store/{key}.tmp-{random}`
2. `fsync()` to disk
3. Rename to `.blobsy/store/{key}`

### Atomic Downloads (Pull)

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

**Stat cache atomicity:** Stat cache writes also use temp-file-then-rename
(file-per-entry, via `atomically` package)

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
| `command` | None (arbitrary commands may lack a safe, side-effect-free health check) | User must test command manually before bulk operations |

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
✓ Backend healthy (s3://my-bucket/project/)
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

### Command Backend Health Check Guidance

Since command backends don’t have automatic health checks, users should test them
manually before relying on them for production workflows.

**Testing Procedure:**

1. **Test push with small file:**
   ```bash
   # Track and push a small test file
   echo "test" > test.txt
   blobsy track test.txt
   blobsy push test.txt
   ```

2. **Verify remote storage:**
   - Check that the remote command actually stored the blob
   - For `command` backends, inspect `$REMOTE_STORAGE_DIR` or run your get command
     manually

3. **Test pull:**
   ```bash
   # Delete local payload and restore
   rm test.txt
   blobsy pull test.txt
   cat test.txt  # Should output "test"
   ```

4. **Test error handling:**
   - Temporarily break the command (e.g., wrong credentials, bad path)
   - Verify that blobsy shows clear error messages

**Optional: User-Defined Health Command (V1.1)**

In V1.1, command backends could support an optional `health_check_command` field:

```yaml
backend:
  url: command://
  command_push: "./custom-upload.sh ${LOCAL_FILE} ${REMOTE_KEY}"
  command_pull: "./custom-download.sh ${REMOTE_KEY} ${LOCAL_FILE}"
  health_check_command: "test -d ${REMOTE_STORAGE_DIR} && test -w ${REMOTE_STORAGE_DIR}"
```

This is deferred to V1.1 pending user feedback on whether it’s needed.

**Implementation note:**

Health checks are implemented in the initial release for S3 and local backends.
Command backends skip health checks in the initial release (deferred to a future
version) since arbitrary commands may not have a safe, side-effect-free health check
operation.
