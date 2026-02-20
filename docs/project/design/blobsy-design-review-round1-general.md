# Review: blobsy Design Doc (Round 1)

**Reviewer:** Claude (senior technical review)

**Date:** 2026-02-19

**Document reviewed:** [blobsy-design.md](blobsy-design.md) (2026-02-18)

## Overall Assessment

The design doc presents a clean, opinionated CLI with sensible defaults.
The core mental model (pointer files + namespaces + delegated transport) is strong.
The pluggable backend/compression/sync architecture is well-thought-out, and the CLI
command surface follows familiar git conventions.

However, there are gaps and underspecified areas that need resolution before
implementation. The weakest parts are directory integrity, conflict detection mechanics,
and several edge cases in namespace handling that aren’t fully specified.

## Critical Issues (Must Resolve Before Implementation)

### C1. Directory integrity model is dangerously weak

**Location:** blobsy-design.md lines 292-303

The design explicitly says “No hashing by default” for directories and “blobsy trusts
the transport layer for directory integrity in V1.” This means:

- `blobsy verify` cannot work for directory targets
- There’s no way to detect silent data corruption or incomplete pulls
- The manifest stores `mtime` and `size` but no checksums per file

The design should at minimum include file hashes in the manifest (even if optional),
since the manifest is already being generated.
Computing SHA-256 while scanning files for the manifest is cheap compared to the upload.

**Recommendation:** Add per-file hashes to the manifest format.
Make them mandatory by default, optional via `checksum: none` in config.

### C2. Conflict detection for single files is incomplete

**Location:** blobsy-design.md lines 789-794

The design defines conflict as: pointer hash = X, local hash = Y, remote hash = Z, if Y
!= X and Z != X then conflict.
But **how do you get the remote hash without downloading the file?** S3 ETags are MD5
(or multipart-upload hash), not SHA-256. The design never specifies where the “remote
hash” is stored or how it’s retrieved cheaply.

This needs a concrete mechanism:

- Storing the hash in S3 object metadata (custom header), or
- A separate hash sidecar file alongside the object, or
- Accepting that conflict detection requires a full download

**Recommendation:** Store SHA-256 as S3 object metadata (`x-amz-meta-sha256`) during
push. Retrieve via HEAD request during conflict check.

### C3. “No Interactive Prompts” contradicts `blobsy init` example

**Location:** blobsy-design.md lines 944-949 vs lines 664-670

The Agent Integration section says “No ‘are you sure?’
prompts. Commands succeed or fail.”
But the Example Session shows `blobsy init` with interactive prompts
(`? Default backend type: s3`, `? Bucket: my-datasets`). These are contradictory.

**Recommendation:** Clarify that `init` may be interactive when run without flags, but
supports fully non-interactive usage via flags (`blobsy init --bucket X --region Y`).
All sync operations are always non-interactive.

### C4. `blobsy sync` (bidirectional) is underspecified and dangerous

**Location:** blobsy-design.md lines 805-815

The design says sync = “pull then push.”
This has subtle issues:

- If remote has new files and local has different new files, pull first downloads remote
  files, then push uploads local files.
  Fine for the additive case.
- But what about deletions?
  Pull with delete semantics would remove local files not in remote, then push with
  delete semantics would remove remote files not (originally) in local.
- The interaction between pull, push, and delete semantics in bidirectional mode needs
  careful specification.

**Recommendation:** Remove `sync` from V1 scope.
Push and pull cover the common cases.
Add bidirectional sync only after real usage reveals demand.

## Significant Issues (Should Resolve Before V1 Ship)

### S1. Namespace branch name sanitization is missing

**Location:** blobsy-design.md lines 174-178

The design uses the Git branch name directly in the remote path prefix.
But branch names can contain:

- Slashes: `feature/auth/oauth2` creates nested S3 prefixes
  `branches/feature/auth/oauth2/`
- Special characters that may cause issues with some S3-compatible stores
- Spaces (technically valid in S3 keys but problematic in CLI usage)

**Recommendation:** Specify a normalization strategy.
Preserve slashes (S3 handles them fine, and this makes remote browsing match branch
names). Escape or reject other special characters (URL-encode anything outside
`[a-zA-Z0-9/_.-]`).

### S2. `blobsy gc` only checks local branches

**Location:** blobsy-design.md lines 846-870

The design says gc “removes `branches/` namespaces that have no corresponding local Git
branch.” But a colleague’s branch that you haven’t fetched would appear stale and get
gc’d.

**Recommendation:** At minimum:

- Check `git branch -r` (remote tracking branches) as well, or
- Accept `--include-remote` flag to check remote refs, or
- Default to checking both local and remote branches
- Warn about this footgun in `--help` and `gc --dry-run` output

### S3. Manifest `mtime` is unreliable for change detection

**Location:** blobsy-design.md lines 319-339

The manifest stores `mtime` per file.
But mtime is unreliable across:

- Git checkouts (git doesn’t preserve mtime)
- Different filesystems (FAT32 has 2-second resolution)
- Docker containers and CI environments
- Timezone differences

If the manifest is the “sync coordination mechanism,” it shouldn’t rely on mtime alone.

**Recommendation:** Add file hashes to the manifest (overlaps with C1). Use mtime as a
fast-path optimization (skip hashing if mtime + size match), but fall back to hash
comparison.

### S4. `version` namespace mode lacks specification

**Location:** blobsy-design.md lines 185-188

The design says version mode uses “an explicit version identifier” set via `--version`
flag or config. But:

- What happens if you push without `--version` when mode is `version`? Error?
  Fallback?
- What happens if you change the version between pushes?
  Is the old namespace orphaned?
- Does `gc` clean up old version namespaces?
  The design says gc “never touches `versions/` namespaces” -- so they accumulate
  forever?

**Recommendation:** Specify: push without `--version` when mode is `version` is an
error. Add `blobsy ns rm versions/<id>` for explicit cleanup.
Consider `blobsy gc --include-versions` for bulk cleanup.

### S5. Per-file namespace overrides create confusing push behavior

**Location:** blobsy-design.md lines 264-275

The design allows a pointer file to override `namespace_mode: fixed`. This means
`blobsy push` in a repo with 5 tracked files could push to 3 different namespace
prefixes. The `blobsy status` output would need to group by namespace, and errors in one
namespace shouldn’t block others.
This interaction isn’t specified.

**Recommendation:** Specify: `blobsy push` groups operations by resolved namespace.
Each namespace group succeeds or fails independently.
`blobsy status` groups output by namespace when mixed namespaces exist.

### S6. Compression suffix ambiguity

**Location:** blobsy-design.md lines 576-578

Compressed files get a `.zst` suffix remotely.
But what about files that already end in `.zst` but are NOT compressed by blobsy
(because `.zst` is in the skip list)?
Remote would have `file.zst` (original, uncompressed) alongside `data.csv.zst`
(compressed by blobsy).
The naming convention is ambiguous -- you can’t tell from the remote filename alone
whether a `.zst` file is blobsy-compressed or natively `.zst`.

**Recommendation:** Options:

1. Accept the ambiguity and rely on the manifest/pointer to track compression state
   (simplest)
2. Use a different suffix pattern for blobsy-compressed files (e.g., `.blobsy.zst`)
3. Store compression state only in manifest metadata, not filename

Option 1 is probably fine since blobsy always uses the manifest/pointer to resolve
files. But document the decision explicitly.

### S7. `sync.tool: auto` detection is fragile

**Location:** blobsy-design.md lines 459-461

Auto tries aws-cli, then rclone, then built-in.
But having aws-cli *installed* doesn’t mean it’s *configured* for the target
bucket/endpoint. Someone with aws-cli installed for other purposes would have
auto-detection select aws-cli, which may then fail for the blobsy-configured endpoint.

**Recommendation:** Auto-detection should verify the tool can reach the target (e.g., a
lightweight check like `aws s3api head-bucket`), or at minimum fail gracefully and fall
through to the next option.
Document that `sync.tool: auto` tries tools in order and falls through on error.

## Minor Issues (Should Address, Low Risk If Deferred)

### M1. Pointer file format details underspecified

**Location:** blobsy-design.md lines 237-275

- `sha256: 7a3f0e...` -- Is this lowercase hex?
  Base64? What length?
  Specify: “64-character lowercase hexadecimal string.”
- `updated: 2026-02-18T12:00:00Z` -- Always UTC? Always this ISO 8601 format?
  Specify: “ISO 8601 UTC timestamp with Z suffix.”
- `size:` -- Bytes? The design implies bytes but never says.
  Specify: “size in bytes.”

### M2. Format versioning strategy missing

**Location:** blobsy-design.md line 241

`format: blobsy/0.1` -- no discussion of what happens when a newer blobsy version
encounters an older format, or vice versa.

**Recommendation:** Specify a compatibility policy: “reject if major version mismatch,
warn if minor version newer than supported.”

### M3. `command` backend template variables are incomplete

**Location:** blobsy-design.md lines 436-437

`push: "my-upload {local} {remote}"` -- doesn’t specify what `{remote}` expands to.
Full S3 URI? Just the key?
Bucket + key? Also:

- Does the command run once per file, or once per push operation?
- What about error handling -- if the command returns non-zero, is the file considered
  failed?
- Are stdout/stderr captured?

### M4. Which `.gitignore` does `blobsy track` modify?

**Location:** blobsy-design.md lines 362-374

The design shows gitignore management with section markers but doesn’t specify which
`.gitignore` file is modified when there are multiple.
Git supports `.gitignore` at every directory level.

**Recommendation:** Follow DVC’s pattern: create/update `.gitignore` in the same
directory as the tracked file.
This keeps gitignore entries co-located with the things they ignore.

### M5. Detached HEAD `shortsha` collision risk

**Location:** blobsy-design.md line 176

Falls back to `detached/<shortsha>/`. Short SHA length isn’t specified.
Even with 7 characters, collisions are possible in large repos.

More importantly, pushes from detached HEAD create namespaces that `gc` won’t clean up
(they’re under `detached/`, not `branches/`). This could leak storage over time,
especially in CI environments.

**Recommendation:** Specify SHA length (full 40-char, or at least 12-char).
Add `gc` handling for `detached/` namespaces (clean up if older than threshold).

### M6. `blobsy export` / `blobsy import` are underspecified

**Location:** blobsy-design.md lines 592-596

The design mentions export/import for tar.zst archives but doesn’t specify:

- Does the archive include pointer files?
- Does `import` create pointer files and gitignore entries?
- Is the archive a flat dump or does it preserve directory structure?
- What compression level?
- Does it support seekable zstd for large archives?

### M7. No discussion of retry/resumability

The design doesn’t address what happens when a push/pull is interrupted midway.
For large directory pushes with hundreds of files:

- Is the manifest updated atomically at the end, or incrementally?
- If interrupted, can you re-run push and it picks up where it left off?

**Recommendation:** Specify: manifest is written atomically at the end of push (temp
file + rename). Re-running push after interruption is safe (idempotent --
already-uploaded files are detected via hash comparison and skipped).

### M8. Dictionary compression for small files not addressed

The design mentions zstd but not dictionary training.
zstd dictionary compression provides 2-5x improvement for small files (< 64 KB) that
share structure -- common with datasets of similar JSON/YAML files.

**Recommendation:** Note dictionary compression as a V2 optimization.
Design the compression interface to support it later (e.g., a `dictionary` field in
config).

### M9. No team adoption workflow

The design covers solo workflows well but doesn’t address team scenarios:

- How does team member B know to run `blobsy pull` after team member A pushes?
- Should there be a CI integration pattern (push in CI, pull in dev)?
- How do you handle the case where someone commits an updated `.blobsy` pointer but
  forgets to `blobsy push`? (The pointer references data that doesn’t exist remotely.)

**Recommendation:** Add a short “Team Workflows” section with guidance.
At minimum: document the “committed pointer with no remote data” failure mode and how
`blobsy status` detects it.

### M10. Integration surface is unstated

Is blobsy intended to be used as a library by other tools?
As a subprocess? Just a standalone CLI? The design should state this explicitly.

**Recommendation:** Add a sentence in Implementation Notes, e.g.: “blobsy is a
standalone CLI. Other tools can invoke it as a subprocess or use its npm package as a
library.”

### M11. The `command` backend is underframed

**Location:** blobsy-design.md lines 435-437

The `command` backend type is framed as an “escape hatch for unsupported backends.”
But it could also serve as a deliberate integration point for domain-specific tools that
want to hook into blobsy with custom upload/download logic.
Worth noting this broader utility in the design.

## Summary: Priority Matrix

| Priority | Issue | ID | Effort |
| --- | --- | --- | --- |
| **P0** | Add file hashes to directory manifests | C1 | Low |
| **P0** | Specify remote hash retrieval for conflict detection | C2 | Medium |
| **P0** | Clarify interactive vs non-interactive behavior | C3 | Low |
| **P0** | Reconsider `sync` in V1 scope | C4 | Low |
| **P1** | Branch name sanitization spec | S1 | Low |
| **P1** | Fix gc to check remote branches | S2 | Low |
| **P1** | Add hashes to manifest; don’t rely on mtime | S3 | Low |
| **P1** | Fully specify `version` mode behavior | S4 | Low |
| **P1** | Specify multi-namespace push behavior | S5 | Medium |
| **P1** | Resolve compression suffix ambiguity | S6 | Low |
| **P1** | Make sync.tool auto-detection robust | S7 | Medium |
| **P2** | Pointer file format details (types, encoding) | M1 | Low |
| **P2** | Format versioning/compatibility policy | M2 | Low |
| **P2** | Command backend template spec | M3 | Low |
| **P2** | Which .gitignore to modify | M4 | Low |
| **P2** | Detached HEAD SHA length and gc handling | M5 | Low |
| **P2** | Export/import specification | M6 | Low |
| **P2** | Retry/resumability spec | M7 | Low |
| **P2** | Dictionary compression as V2 note | M8 | Low |
| **P2** | Team adoption workflow guidance | M9 | Medium |
| **P2** | State integration surface | M10 | Low |
| **P2** | Reframe command backend as integration point | M11 | Low |
