---
title: Native rclone Backend Support
description: First-class rclone transfer tool support for multi-cloud storage (GCS, S3, Azure, 70+ backends)
author: Joshua Levy with Claude assistance
---
# Feature: Native rclone Backend Support

**Date:** 2026-02-24

**Author:** Joshua Levy with Claude assistance

**Status:** Draft

## Overview

Add first-class rclone support as a transfer tool in blobsy, enabling native transfers
to Google Cloud Storage, Azure Blob Storage, and 70+ other storage backends without
requiring cloud-specific SDKs or CLIs.

This follows the existing pattern established by `AwsCliBackend` — delegating transfers
to an external CLI tool that the user has already installed and configured — and extends
it to rclone, which is the best general-purpose choice for multi-cloud storage
transfers.

## Goals

- **GCS support via rclone:** Users with `rclone` configured for GCS can use
  `gs://bucket/prefix/` URLs with zero additional dependencies or SDK setup
- **Multi-cloud from one tool:** Same implementation covers S3, GCS, Azure, B2, and 70+
  backends — wherever rclone works, blobsy works
- **Externalize auth:** rclone handles all authentication (OAuth, service accounts, HMAC
  keys, interactive config).
  Blobsy never touches credentials
- **Consistent with existing patterns:** Follow the `AwsCliBackend` implementation
  pattern exactly — same `Backend` interface, same atomic pull behavior, same error
  categorization
- **CLI-first philosophy:** Aligns with blobsy’s principle #7 (externalize everything) —
  no new npm dependencies for cloud SDKs

## Non-Goals

- **Google Cloud SDK (`@google-cloud/storage`)**: Not implementing SDK-based GCS access.
  Users who need GCS use rclone or the command backend with `gcloud storage cp`
- **Azure SDK (`@azure/storage-blob`)**: Same — rclone covers Azure
- **rclone config management**: Blobsy does not create, modify, or inspect rclone
  config. Users must configure rclone separately (`rclone config`)
- **Batch transfer optimization (`--files-from`)**: Deferred.
  Per-file `rclone copyto` is sufficient for V1.1. Batch mode is a V2 optimization
- **rclone-specific features**: No support for rclone mount, sync, bisync, or other
  advanced features. Blobsy uses rclone as a per-file copy engine only

## Background

### Why rclone over cloud-specific CLIs

The original design deferred both GCS and rclone support to V1.1. After analysis, rclone
is the right first step for multi-cloud support because:

1. **GCS CLI (`gcloud`) is clunky.** It’s Python-based with significant startup overhead
   (200-500ms per invocation), and its auth model is confusing (`gcloud auth login` vs
   `gcloud auth application-default login` — the SDK doesn’t inherit the former).
   Some GCS users have explicitly moved to rclone over `gsutil`/`gcloud`.

2. **rclone is a single Go binary.** Fast startup, no runtime dependencies, consistent
   cross-platform behavior.
   Already widely adopted in the data engineering community.

3. **One implementation covers everything.** Instead of building `GCloudCliBackend`,
   `AzCopyBackend`, etc., a single `RcloneBackend` covers GCS, Azure, B2, Wasabi,
   Tigris, and any future storage provider.

4. **Already designed in.** The design docs list rclone in `sync.tools` default ordering
   (`[aws-cli, rclone]`) and reference `rclone copyto` as the transfer command.

### Current state

- `AwsCliBackend` exists and works — rclone backend follows the same pattern
- `BackendType` already includes `'gcs'` and `'azure'`
- URL parsing for `gs://` and `azure://` is implemented in `backend-url.ts`
- `transfer.ts:createBackend()` has a stub that throws for `gcs`/`azure`
- `sync.tools` config field exists but is not yet wired up
- The command backend already allows `rclone copyto` via manual configuration

## Design

### Approach

Create a `RcloneBackend` class that implements the `Backend` interface, following the
`AwsCliBackend` pattern.
The backend translates blobsy’s storage URLs into rclone remote paths and executes
`rclone` commands for each operation.

### rclone Remote Path Construction

rclone uses `remote:path` syntax where `remote` is a named remote from
`~/.config/rclone/rclone.conf`. Blobsy needs to map its URL-based config to rclone
remotes.

**Two modes of operation:**

1. **Named remote (explicit):** User specifies the rclone remote name in config:

   ```yaml
   backends:
     default:
       url: gs://my-bucket/project-data/
       rclone_remote: my-gcs   # explicit rclone remote name
   ```

   rclone path becomes: `my-gcs:my-bucket/project-data/{remoteKey}`

2. **Auto-detect from URL scheme (convenience):** For common schemes, blobsy can
   construct rclone paths using `:backend:` syntax (rclone’s on-the-fly backend
   specifier):

| blobsy URL | rclone path |
| --- | --- |
| `s3://bucket/prefix/key` | `:s3:bucket/prefix/key` (or named remote) |
| `gs://bucket/prefix/key` | `:gcs:bucket/prefix/key` (or named remote) |
| `azure://container/prefix/key` | `:azureblob:container/prefix/key` (or named remote) |

The `:backend:` syntax requires rclone env vars or flags for auth (e.g.,
`RCLONE_GCS_SERVICE_ACCOUNT_FILE`). Named remotes are generally more reliable.

**Recommended approach for V1.1:** Require `rclone_remote` in config for now.
The `:backend:` auto-detect is a convenience that can be added later once we understand
usage patterns. This keeps the implementation simple and avoids auth confusion.

### Backend Interface Implementation

```typescript
// backend-rclone.ts
export class RcloneBackend implements Backend {
  readonly type: BackendType;  // 'gcs', 'azure', or 's3'

  push(localPath, remoteKey)   // rclone copyto local remotePath
  pull(remoteKey, localPath)   // rclone copyto remotePath tmpFile → verify → rename
  exists(remoteKey)            // rclone lsf remotePath (exit 0 = exists)
  delete(remoteKey)            // rclone deletefile remotePath
  healthCheck()                // rclone lsf remote:bucket/prefix/ --max-depth=0
}
```

### rclone Commands

| Operation | rclone Command |
| --- | --- |
| push | `rclone copyto {localPath} {remote}:{bucket}/{prefix}{remoteKey}` |
| pull | `rclone copyto {remote}:{bucket}/{prefix}{remoteKey} {tmpPath}` |
| exists | `rclone lsf {remote}:{bucket}/{prefix}{remoteKey}` |
| delete | `rclone deletefile {remote}:{bucket}/{prefix}{remoteKey}` |
| healthCheck | `rclone lsf {remote}:{bucket}/{prefix} --max-depth 1 --max-count 1` |

**Why `rclone copyto` instead of `rclone copy`:** `copyto` copies a single file to an
exact destination path (like `cp`). `copy` copies to a destination directory (like `cp`
into a folder). Since blobsy operates on individual files with exact remote keys,
`copyto` is the correct command.

### Config Changes

Add optional `rclone_remote` field to `BackendConfig`:

```typescript
export interface BackendConfig {
  // ... existing fields ...
  /** rclone remote name for transfer delegation */
  rclone_remote?: string | undefined;
}
```

In `.blobsy.yml`:

```yaml
backends:
  default:
    url: gs://my-bucket/project-data/
    rclone_remote: my-gcs-remote
```

### Tool Selection Logic in `createBackend()`

Update `transfer.ts:createBackend()`:

```
case 'gcs':
case 'azure':
  if (config.rclone_remote && isRcloneAvailable()) {
    return new RcloneBackend(config);
  }
  throw new BlobsyError(
    `${config.type} backend requires rclone. Install rclone and configure a remote.`,
    'not_found',
    1,
    ['Install: https://rclone.org/install/',
     'Configure: rclone config',
     'Then set rclone_remote in .blobsy.yml']
  );

case 's3':
  // Existing logic, but add rclone as another fallback:
  // 1. If tools includes 'aws-cli' and aws CLI available → AwsCliBackend
  // 2. If tools includes 'rclone' and rclone available → RcloneBackend
  // 3. Fallback to BuiltinS3Backend
```

### Error Categorization

rclone error messages follow consistent patterns.
Map them using the existing `categorizeCommandError()` from `backend-command.ts`, which
already handles the common patterns (access denied, not found, network, permission,
quota, storage full).

rclone-specific patterns to add if needed:

| rclone stderr pattern | Category |
| --- | --- |
| `Failed to create file system` | `authentication` or `not_found` |
| `directory not found` | `not_found` |
| `AccessDenied` / `Forbidden` | `authentication` |
| `couldn't find remote` | `validation` (misconfigured remote name) |

### Doctor Integration

Add rclone checks to `blobsy doctor`:

- rclone binary available in PATH
- rclone version (warn if very old)
- If `rclone_remote` is configured, verify the remote exists: `rclone listremotes`
- Backend health check via the configured remote

### Components

| File | Changes |
| --- | --- |
| `backend-rclone.ts` | **New.** `RcloneBackend` class + `isRcloneAvailable()` |
| `transfer.ts` | Wire `RcloneBackend` into `createBackend()` for gcs/azure/s3 |
| `types.ts` | Add `rclone_remote` to `BackendConfig` |
| `config.ts` | Accept `rclone_remote` as known config key |
| `commands-stage2.ts` | Doctor checks for rclone availability and remote config |

### No API Changes

The `Backend` interface is unchanged.
`RcloneBackend` implements the same 5 methods as every other backend.
No new commands or CLI flags are needed.

## Implementation Plan

### Phase 1: Core rclone backend

- [ ] Add `rclone_remote` to `BackendConfig` in `types.ts`
- [ ] Add `rclone_remote` to known config keys in `config.ts`
- [ ] Create `backend-rclone.ts` with `RcloneBackend` implementing `Backend`
- [ ] Implement `isRcloneAvailable()` detection
- [ ] Implement push/pull/exists/delete/healthCheck using rclone commands
- [ ] Atomic pull: temp file → hash verify → rename (match `AwsCliBackend` pattern)

### Phase 2: Wire into transfer coordinator

- [ ] Update `createBackend()` in `transfer.ts` to use `RcloneBackend` for gcs/azure
- [ ] Add rclone as S3 fallback option when `sync.tools` includes `'rclone'`
- [ ] Error messages with helpful setup instructions for missing rclone

### Phase 3: Doctor and testing

- [ ] Add rclone availability check to doctor
- [ ] Add rclone remote validation to doctor (when `rclone_remote` configured)
- [ ] Unit tests for `RcloneBackend` (mock `execFileSync`)
- [ ] Unit tests for rclone path construction
- [ ] Integration test with local rclone remote (rclone supports `local` remote type)
- [ ] Golden tests for doctor output with rclone checks

### Phase 4: Documentation updates

Update all docs and specs that currently mark rclone/GCS/Azure as deferred.
See the detailed audit below.

- [ ] Update design docs to reflect rclone as implemented (not deferred)
- [ ] Update specs that reference deferral status
- [ ] Update golden tests that expect errors for GCS/Azure init
- [ ] Add rclone setup instructions to README/SKILL.md
- [ ] Add example `.blobsy.yml` configs for GCS-via-rclone and Azure-via-rclone

## Testing Strategy

**Unit tests:**

- `RcloneBackend` with mocked `execFileSync` — verify correct rclone commands are
  constructed for each operation
- Path construction: URL → rclone remote path mapping
- Error categorization: rclone stderr → `ErrorCategory`
- `isRcloneAvailable()` with mocked binary detection

**Integration tests:**

- rclone supports a `local` remote type (filesystem-to-filesystem).
  This enables full integration testing without any cloud credentials:

  ```bash
  # Create a local rclone remote for testing
  rclone config create test-local local root /tmp/rclone-test
  ```

  This exercises the full path: blobsy → rclone → filesystem, verifying command
  construction, temp file handling, hash verification, and atomic rename.

- Alternatively, if rclone is not available in CI, tests can be skipped with a clear
  message (same pattern as the aws-cli tests).

**Golden tests:**

- Doctor output showing rclone status (available/not available)
- Error messages for missing rclone, misconfigured remote
- Push/pull output with rclone backend

## Documentation and Code Audit

Precise file:line locations that need updating when this feature is implemented.

### Source code changes

**`packages/blobsy/src/backend-rclone.ts`** — New file.
`RcloneBackend` class + `isRcloneAvailable()`.

**`packages/blobsy/src/transfer.ts`**

- Line 132-134: Replace `throw BlobsyError('Cloud backend not yet implemented')` stub
  with `RcloneBackend` instantiation for `gcs` and `azure` cases
- Line 98-131: Add rclone as fallback in the `s3` case (after aws-cli, before SDK)

**`packages/blobsy/src/types.ts`**

- Line 67-82: Add `rclone_remote?: string | undefined` to `BackendConfig` interface

**`packages/blobsy/src/config.ts`**

- Line 52: `tools: ['aws-cli', 'rclone']` — default already correct, no change needed
- Add `rclone_remote` to known config keys (for doctor did-you-mean validation)

**`packages/blobsy/src/commands-stage2.ts`** — Add rclone doctor checks (binary
availability, remote validation)

### Critical — Design docs

**`docs/project/design/current/blobsy-backend-and-transport-design.md`**

- Line 14: `⏸️ **Deferred to V1.1+:**` — remove or update header
- Line 15:
  `- Transfer tool delegation (aws-cli, rclone, s5cmd) - fully designed but not implemented`
  — mark rclone as implemented
- Line 16: `- GCS backend ('gs://')` — mark implemented via rclone
- Line 17: `- Azure Blob Storage backend ('az://')` — mark implemented via rclone
- Line 359-364: `gcs` and `azure` backend type descriptions — remove “Deferred to a
  future version”
- Line 478-485: `🚧 V1.1 Feature` note — update: rclone delegation now implemented
- Line 530-539: V1 Implementation Note saying `sync.tools` is “accepted but ignored” and
  warning message example — remove or mark historical
- Line 572: `rclone config (when rclone is selected from sync.tools)` — now functional

**`docs/project/design/current/blobsy-design.md`**

- Line 1297-1298: Backend type determination table — `gs://` and `azure://` now work via
  rclone
- Line 2208: `tools: [aws-cli, rclone]` — note this is now functional
- Line 2297: Same `tools: [aws-cli, rclone]` in another config example
- Line 3304-3309: Deferred features table — mark these rows as implemented:
  - `Transfer tool delegation (aws-cli, rclone)` — ~2 weeks
  - `GCS backend (gs://)` — ~1 week
  - `Azure Blob backend (az://)` — ~1 week

### High — Specs with deferral references

**`docs/project/specs/active/plan-2026-02-21-blobsy-phase1-implementation.md`**

- Line 31: `Cloud backends (S3, R2, GCS, Azure) -- deferred` — GCS/Azure now work via
  rclone
- Line 402: `sync.tools: [aws-cli, rclone]` — now functional

**`docs/project/specs/active/plan-2026-02-21-blobsy-phase2-v1-completion.md`**

- Line 37: `Azure backend (azure://) -- deferred` — now implemented
- Line 146-147: `Transfer tool delegation (aws-cli, rclone) is deferred to V1.1` —
  rclone now implemented
- Line 178-187: `Transfer Tool Delegation (Deferred to V1.1)` and
  `GCS Backend (Deferred to V1.1)` section headers — update status
- Line 435-438: Deferred features list: `GCS backend` and `Transfer tool delegation` —
  update

### High — Golden tests expecting errors for GCS/Azure

**`packages/blobsy/tests/golden/commands/init.tryscript.md`**

- Line 55-56: `gs://my-bucket/prefix/` and `azure://my-container/prefix/` in supported
  schemes error — init now succeeds (or fails with “rclone not configured”)
- Line 77: `$ blobsy init gs://my-bucket/prefix/` — test case now succeeds
- Line 87: `url: gs://my-bucket/prefix/` in expected config output
- Line 99: `$ blobsy init azure://my-container/prefix/` — test case now succeeds
- Line 109: `url: azure://my-container/prefix/` in expected config output

**`packages/blobsy/tests/golden/commands/setup.tryscript.md`**

- Line 104-105: `gs://` and `azure://` in supported schemes error output

**`packages/blobsy/tests/golden/errors/validation-errors.tryscript.md`**

- Line 59-60: `gs://` and `azure://` in error output

**`packages/blobsy/tests/golden/json/config-json.tryscript.md`**

- Line 62: `rclone` in sync tools config — no change needed

### Moderate — User-facing docs

**`README.md`**

- Line 161-163: rclone command backend examples — update to show native rclone backend
  as preferred, command backend as alternative
- Line 322-324: Comparison table — update to show GCS/Azure support

**`packages/blobsy/docs/blobsy-docs.md`**

- Line 63: `tools: ["aws-cli", "rclone"]` — now functional
- Line 179: `command:rclone copyto` example — add native rclone backend example

**`packages/blobsy/SKILL.md`** — Add rclone setup instructions for agents

### Minor — Reference docs

- `docs/project/design/current/issues-history.md` line 130: “initial release ships with
  aws-cli + rclone” — now accurate
- `docs/project/specs/active/plan-2026-02-21-golden-test-quality-improvement.md` line
  44: cloud backend tests — GCS via rclone now testable
- `docs/project/specs/active/plan-2026-02-23-improved-doctor-and-status.md`: Doctor
  output may need rclone check additions

### No updates needed (informational reference only)

- `docs/project/research/current/research-2026-02-19-sync-tools-landscape.md`
- `docs/project/research/current/research-2026-02-19-atomic-file-writes.md`
- `docs/project/research/current/research-2026-02-19-backing-store-features.md`
- `docs/project/design/archive/*.md` (9 archived review docs)

## Open Questions

- **`:backend:` syntax vs named remotes only?** Starting with named remotes
  (`rclone_remote` config) is simpler and more reliable.
  Should we also support rclone’s on-the-fly `:gcs:` syntax for zero-config convenience,
  or is that a V2 enhancement?

- **rclone flags passthrough?** Should we support extra rclone flags (e.g.,
  `--transfers`, `--checkers`, `--retries`) via config?
  Or leave that to the command backend for advanced users?

- **Minimum rclone version?** rclone `copyto` and `lsf` have been stable for years.
  Should we enforce a minimum version or just document recommendations?

## References

- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
  — Backend types, transfer delegation design
- [blobsy-design.md](../../design/current/blobsy-design.md) — Main design doc, backend
  overview
- [backend-aws-cli.ts](../../../../packages/blobsy/src/backend-aws-cli.ts) — Reference
  implementation pattern
- [rclone.org](https://rclone.org/) — rclone documentation
- [rclone Google Cloud Storage](https://rclone.org/googlecloudstorage/) — GCS-specific
  rclone docs
