# Research: Object Store Capabilities Refresh (Oct 2026)

**Date:** 2026-10-22 **Status:** Reference (supersedes parts of the Feb 2026 research,
see §2.2)

**Related:**

- [research-2026-02-19-backing-store-features.md](research-2026-02-19-backing-store-features.md)
  — prior provider survey (pricing, compression, checksums)
- [research-2026-02-19-atomic-file-writes.md](research-2026-02-19-atomic-file-writes.md)
  — local atomic-write behavior of transports
- [blobsy-backend-and-transport-design.md](../../design/current/blobsy-backend-and-transport-design.md)
- [blobsy-design-review-round8-run-sync-workflows.md](../../design/current/blobsy-design-review-round8-run-sync-workflows.md)
  — mirror mode and receipts

**Verification legend** (applied to claims throughout):

- **[V]** verified in this pass from a primary source: official provider docs, official
  changelog/announcement, or the tool’s own source code (URL in §8).
- **[S]** secondary source only (forum post, vendor-neutral blog, packager notes).
- **[I]** inferred or carried over from earlier research; not re-verified here.

## 1. Summary for blobsy

The Feb 2026 research asked what object stores can do.
This refresh asks a narrower question, framed by use cases UC-1 to UC-5 and the adopted
invariant that **remote blobs are immutable once published; push never overwrites an
existing key.** The headline findings:

1. **Create-only PUT (`If-None-Match: *`) can now enforce the immutability invariant
   server-side, not just by convention.** AWS S3 supports it on PutObject,
   CompleteMultipartUpload, and (since 2025-10-29) CopyObject.
   Bucket policy can *require* it [V]. Azure supports it on Put Blob and Put Block List
   [V]. R2 [V], Tigris [V], and MinIO [V] support it on PutObject.
   GCS has the equivalent `ifGenerationMatch=0` [V]. **Backblaze B2 rejects the header**
   [S], and Wasabi’s support is undocumented.
2. **The tools blobsy uses already expose create-only writes, with gaps.** `aws s3 cp
   --no-overwrite` (CLI v2.33.0+) sends `If-None-Match: *` on PutObject,
   CompleteMultipartUpload, and CopyObject [V, source code]. rclone ≥ v1.72.0 passes
   `--header-upload "If-None-Match: *"` through on S3 PutObject and
   CompleteMultipartUpload [V, source code]. **rclone’s GCS and Azure backends do not
   pass conditional headers** [V, source code], so blobsy’s rclone path for `gs://` and
   `azure://` cannot do an atomic create-only write today.
   `@aws-sdk/lib-storage` `Upload` spreads `IfNoneMatch` into both PutObject and
   CompleteMultipartUpload [V, source of the version installed in this repo].
3. **S3 can now store and return blobsy’s own SHA-256 for single-part objects.** That
   gives verification without download.
   S3 validates a supplied `x-amz-checksum-sha256` server-side and stores it.
   `HeadObject` with `ChecksumMode=ENABLED` returns it.
   For multipart uploads, SHA-256 is **composite only**; full-object checksums exist
   only for CRC32, CRC32C, and CRC64NVME [V]. S3 added MD5, SHA-512, and XXHash variants
   on 2026-04-23 [V]. Batch Operations “Compute checksum” (2025-08-18) verifies at rest
   without download, at $0.004/GB [V].
4. **Immutability features improved for UC-5.** S3 Object Lock gained *variable
   retention with event holds* on 2026-09-08 [V]. R2 gained prefix-scoped *bucket locks*
   on 2025-03-06 [V]. B2 has full S3 Object Lock [V]; the Feb doc said it did not.
   Caveat: Object Lock protects *versions*, not *keys*. It does not stop a new version
   or a delete marker from landing on top [V]. Pair it with create-only PUT.
5. **No general-purpose store offers multi-object atomic commit.** “Publish a set” still
   means: upload the immutable content, then write the manifest or receipt **last**,
   create-only, then optionally move a mutable pointer with `If-Match` compare-and-swap
   (CAS). S3 RenameObject (2025-06-18) is single-object and Express One Zone only [V].
   GCS hierarchical namespace (HNS) folder rename is atomic but excludes versioning,
   Bucket Lock, and Retention Lock [V].
6. **Many small files are a request-count problem, not a bytes problem.** About $5 per
   million PUTs on S3, GCS, R2, and Tigris.
   Process-per-file transfer is slower still, and blobsy currently spawns one process
   per file. For UC-3, pack into content-addressed archives.
   For UC-2, use one batched transfer process (rclone `--files-from`/`--files-from0`, or
   `gcloud storage cp -I`).
7. **MinIO Community Edition is dead upstream.** Admin UI stripped (2025), binaries and
   images stopped (Oct 2025), maintenance mode (Dec 2025), repo archived (Feb 2026 and
   again Apr 25, 2026) [V for archive and README; S for intermediate dates]. Do not
   recommend it as blobsy’s default self-hosted or test target.

## 2. What changed since Feb 2026

### 2.1 Dated changes (chronological, includes late-2025 items the Feb doc missed)

| Date | Change | Relevance | Ver. |
| --- | --- | --- | --- |
| 2024-08-20 | S3 conditional writes `If-None-Match` on PutObject/CompleteMultipartUpload | Create-only publish | [V] |
| 2024-11-25 | S3 `If-Match` (ETag CAS) on PutObject/CompleteMultipartUpload; bucket-policy enforcement keys `s3:if-none-match`/`s3:if-match` | Pointer CAS; enforce invariant | [V] |
| 2024-12 | AWS SDKs/CLI default request checksums (`WHEN_SUPPORTED`); S3 auto-stores CRC64NVME on all new objects | Free integrity; breaks some S3-compatibles | [V] |
| 2025-03-06 | R2 bucket locks (prefix retention rules, indefinite allowed) | UC-5 on R2 | [V] |
| 2025-04-10 | S3 Express One Zone price cut (storage −31%, PUT −55%, GET −85%) | Hot UC-3 cache tier | [V] |
| 2025-06-18 | S3 Express One Zone `RenameObject` (atomic, single object, supports `If-None-Match`) | Not a set-commit primitive | [V] |
| 2025-08-18 | S3 Batch Operations “Compute checksum” (at-rest, no download) | Bulk verification/audit | [V] |
| 2025-08-22 | rclone v1.71.0: bisync stable; BLAKE3/XXH3/XXH128 hashes | Minor | [V] |
| 2025-09-16 | S3 conditional deletes (`If-Match` on DeleteObject/DeleteObjects) | Safe GC | [V] |
| 2025-10 → 2026-04 | MinIO CE: binaries/images stop → maintenance mode → archived | Self-hosted/test target | [V]/[S] |
| 2025-10-29 | S3 conditional writes on CopyObject (general + directory buckets) | Server-side promote/copy | [V] |
| 2025-11-21 | rclone v1.72.0: S3 `If-Match`/`If-None-Match` via `--header-upload`; archive backend; paged listing (ListP) | Create-only via rclone (S3 only) | [V] |
| 2026-01-30 → 04-19 | rclone v1.73.0–v1.73.5 (security fixes, new backends) | Pin ≥ 1.73.5 | [V] |
| 2026-04-23 | S3 adds MD5, SHA-512, XXHash3/64/128 checksums (10 total) | Still no full-object SHA-256 for multipart | [V] |
| 2026-05-01 | rclone v1.74.0: S3 Object Lock flags; rc API auth required by default | UC-5 via rclone | [V] |
| 2026-06 | S3 annotations: mutable per-object metadata (≤1000 × 1 MB) without rewrite; locked objects reject annotation edits | Possible receipt attachment (S3-only) | [S] |
| 2026-07-01 | Wasabi pay-as-you-go raised to $7.99/TB/mo; 90-day minimum unchanged | Pricing | [V] |
| 2026-07-20 | GCS lifecycle `sizeAboveBytes`/`sizeBelowBytes` | Cache TTL by size | [V] |
| 2026-07-31 | rclone v1.75.0: `--files-from0`; Azure `list_parallelism`; serve s3 streaming MPU | Batched transfers | [V] |
| 2026-08-26 | GCS HNS lifecycle `Delete` also deletes empty folders (breaking change) | HNS buckets only | [V] |
| 2026-09-04 | rclone v1.75.1: security fixes (archive zip-slip), serve-s3 auth-proxy breaking change | Pin version | [V] |
| 2026-09-08 | S3 Object Lock variable retention with event holds | UC-5 retention “until superseded + N days” | [V] |
| 2026-09-30 | GCS client libraries apply end-to-end checksums by default | Integrity | [V] |
| 2026-10-09 | rclone v1.75.2 (latest): security fixes; `--copy-dest` respects `--immutable` | Current version | [V] |

### 2.2 Corrections to the Feb 2026 research

- **B2 Object Lock:** Feb matrix said “No.”
  B2 supports S3 Object Lock (compliance, governance, legal hold, default retention) via
  its S3 API [V].
- **R2 versioning / Object Lock:** Feb said versioning “Yes” and Object Lock “No.”
  R2’s S3 API lists Get/PutBucketVersioning and Object Lock operations as
  *unimplemented* [V]. R2 instead has **bucket locks**, prefix retention rules set
  through the dashboard, Wrangler, or the API [V].
- **B2 pricing:** Feb said $5/TB with paid Class B/C. The current page says $6.95/TB,
  Class A/B/C calls free, Class D $0.004/10k after 2,500/day [V].
- **Wasabi pricing:** $7.99/TB/mo pay-as-you-go since 2026-07-01 (was $6.99) [V].
- **S3 checksums:** Feb said CRC64NVME is full-object for multipart and SHA-256 can be
  requested. Both are true, but **SHA-256 on multipart is composite only** [V]. The
  CLI/SDK default algorithm differs by SDK: CLI v2 uses CRC64NVME, **JS SDK v3 uses
  CRC32** [V].
- **Tigris versioning:** still unsupported at the bucket-API level
  (Get/PutBucketVersioning ❌), although snapshots and forks now exist [V].

## 3. Provider × capability matrix

### 3.1 Conditional writes (immutability and CAS)

| Provider | Create-only PUT | Create-only multipart complete | CAS (`If-Match`) PUT | Conditional copy (dest) | Conditional delete | Enforce via policy | Ver. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AWS S3 (general) | `If-None-Match: *` | Yes (CompleteMultipartUpload) | Yes | Yes (2025-10-29) | `If-Match` ETag or `*` | Yes (`s3:if-none-match`) | [V] |
| S3 Express One Zone | Yes | Yes | Yes | Yes | Yes | n/a | [V] |
| GCS (JSON API) | `ifGenerationMatch=0` | Resumable/JSON: yes | `ifGenerationMatch=<gen>` | Yes (rewrite/copy preconditions) | `ifGenerationMatch` | No | [V] |
| GCS (XML/S3 interop) | `x-goog-if-generation-match: 0`; `If-None-Match` is read-only there | **No** (XML MPU preconditions → 400 NotImplemented) | `x-goog-if-generation-match` | — | — | No | [V] |
| Azure Blob | `If-None-Match: *` on Put Blob | Yes, on Put Block List | Yes | Yes (Copy Blob) | Yes | No | [V] |
| Cloudflare R2 | Yes, atomic against committed state | **Not listed** for CompleteMultipartUpload | Yes | Source-side only (`x-amz-copy-source-if-*`) plus `cf-copy-destination-if-*` extension | — | No | [V] |
| Backblaze B2 | **Rejected with error** | — | — | — | — | — | [S] |
| Tigris | Yes | Not documented | Yes | Source-side only | — | No | [V] |
| Wasabi | Undocumented (forum says yes) | Unknown | Unknown | Unknown | Unknown | — | [S] |
| MinIO / AIStor | Yes (since 2023) | Unknown | Yes | — | `If-Match` on delete | — | [V]/[S] |

Semantics to rely on (AWS, [V]):

- Concurrent create-only writers: the first to finish wins; the rest get `412`.
- A concurrent delete can cause `409 Conflict`. PutObject can retry after that, but
  CompleteMultipartUpload requires restarting the whole multipart upload.
- In versioned buckets, `If-None-Match` checks only the *current* version.
  **If the current version is a delete marker, the create succeeds.**
- In-progress multipart uploads are invisible to conditionals.
  A PUT can win while a multipart upload (MPU) is underway, and the MPU’s Complete then
  fails with `412`.

### 3.2 Checksums and verification without download

| Provider | Default stored hash | Full-object SHA-256 retrievable? | Multipart whole-file hash | Read-back | Ver. |
| --- | --- | --- | --- | --- | --- |
| AWS S3 | CRC64NVME (always, server-side) | **Yes for single-part PUT** if client sends `x-amz-checksum-sha256` | CRC64NVME/CRC32/CRC32C full-object; SHA-*/MD5/XXH composite only | `HeadObject` + `ChecksumMode=ENABLED`; `GetObjectAttributes` | [V] |
| S3 at rest | — | Batch Ops Compute checksum (report, not metadata), any algorithm, full or composite | — | Completion report CSV; $0.004/GB + $0.25/job + $1/M objects | [V] |
| GCS | CRC32C always; MD5 non-composite | No (only CRC32C/MD5) | CRC32C | Object metadata | [I] |
| Azure Blob | MD5 auto on Put Blob only | No | None unless the client sets `x-ms-blob-content-md5` | Blob properties | [V] (Put Blob) / [I] |
| R2 | MD5 ETag (single part) | SHA-256 listed as composite type only | CRC64NVME full-object only | ETag / checksum headers | [V] (table) |
| B2 | SHA-1 (non-large files) | No | None unless `large_file_sha1` is set | `X-Bz-Content-Sha1` | [I] |
| Tigris | MD5 ETag | PutObject with SHA-256 checksum listed ✅ | Composite ETag | — | [V]/[I] |

rclone note: rclone’s S3 hash is **MD5 only**. It reads the ETag for single-part objects
and `X-Amz-Meta-Md5chksum` for multipart uploads it did itself [V]. `rclone
check` therefore cannot compare against blobsy’s SHA-256.

### 3.3 Immutability, retention, versioning, soft delete

| Provider | WORM / retention | Versioning | Soft delete | Notes | Ver. |
| --- | --- | --- | --- | --- | --- |
| AWS S3 | Object Lock: governance/compliance, legal hold, **variable retention + event holds** (2026-09-08); can be enabled on existing buckets | Required for Object Lock | No (versioning plays this role) | Lock protects a *version*; new versions and delete markers still allowed | [V] |
| GCS | Bucket Lock (retention policy), Object Retention Lock, holds | Yes | **On by default (7d; 7–90d or 0)**, billed | HNS buckets exclude versioning, Bucket Lock, Retention Lock | [V]/[S] |
| Azure Blob | Version-level or container WORM (time-based, legal hold) | Yes | Blob/container soft delete | Writes under a WORM policy require versioning enabled | [S] |
| R2 | **Bucket locks**: prefix rules, duration, date, or indefinite; block overwrite *and* delete; override lifecycle | No (API unimplemented) | No | Up to 1,000 rules; bucket can’t be emptied while locked | [V] |
| B2 | S3 Object Lock (full) | Always on | Lifecycle “hide” semantics | Can enable on an existing bucket | [V] |
| Tigris | Not documented | No (bucket API) | — | Snapshots and forks (zero-copy) | [V] |
| Wasabi | Object Lock | Yes | — | 90-day minimum storage duration (pay-as-you-go) | [V]/[I] |

### 3.4 Atomic multi-object publish primitives

| Mechanism | Scope | Atomic for a set? | Ver. |
| --- | --- | --- | --- |
| Single PUT / CompleteMultipartUpload | One object | Object appears fully or not at all | [V] |
| S3 `RenameObject` | One object, Express One Zone only | No | [V] |
| GCS HNS folder rename | Folder subtree, HNS buckets | **Yes**, but HNS forfeits versioning and locks; Class A ops ~30% pricier ($0.0065 vs $0.005/1k) | [V] |
| Azure ADLS Gen2 (HNS) directory rename | Directory | Yes | [I] |
| S3 Tables / R2 Data Catalog (Iceberg) | Table snapshots via catalog pointer CAS | Yes, for tabular data only | [I] |
| Manifest-last + pointer CAS (§5.3) | Any store with create-only + `If-Match` | Logically yes (readers follow the pointer) | design |

### 3.5 Lifecycle / TTL for caches (UC-3)

| Provider | Expire by age | Other filters | Abort stale MPUs | Gotchas | Ver. |
| --- | --- | --- | --- | --- | --- |
| AWS S3 | Yes (days) | Prefix, tags, size | Yes | IA/Glacier IR: 128 KB minimum billable object size | [V] |
| GCS | Yes | Prefix/suffix, **size** (2026-07-20), custom time | Yes | Soft delete keeps deleted cache bytes billable 7+ days unless disabled | [V] |
| R2 | Yes | Prefix; Standard → IA transition | Yes | Bucket locks override lifecycle | [V] |
| Azure | Yes (creation, modification, last access) | Prefix, tags | n/a | Cool/Cold/Archive 128 KiB minimum billable size for new accounts from 2026-07-01 | [S] |
| Tigris | Lifecycle rules (tier transitions documented) | — | — | Expiration not documented on the features page | [V] |
| Wasabi | Yes | — | — | 90-day minimum makes short TTL caches pay 90 days anyway | [V] |

## 4. Tool exposure (what blobsy can use without new SDKs)

| Tool | Create-only | Checksum control | Batch/many-file | Ver. |
| --- | --- | --- | --- | --- |
| aws-cli v2 (≥2.33.0) | `aws s3 cp/mv --no-overwrite` → `IfNoneMatch="*"` on PutObject, CompleteMultipartUpload, CopyObject. **For `sync`, `--no-overwrite` is popped and becomes a listing-based skip, not a conditional write.** | `--checksum-algorithm` (CRC64NVME default; SHA256; XXH*/SHA512 since ~2.34.35); `--checksum-mode` | `sync` only; no `--files-from` | [V] source |
| aws-cli s3api | `put-object/copy-object/complete-multipart-upload --if-none-match '*'`, `--if-match` | `--checksum-sha256` etc. | per call | [V] |
| rclone ≥1.72 (S3 backend) | `--header-upload "If-None-Match: *"` → PutObject and CompleteMultipartUpload; also server-side copy | MD5 only for `check`; `--s3-use-data-integrity-protections` tristate | `copy --files-from[0] --no-traverse --transfers N` | [V] source |
| rclone (GCS / Azure backends) | **No conditional headers mapped**; `--immutable`/`--ignore-existing` are check-then-act (racy) | GCS MD5/CRC32C; Azure MD5 | same | [V] source |
| rclone ≥1.74 | `--s3-object-lock-mode/-retain-until-date/-legal-hold-status`, `--s3-object-lock-set-after-upload` | — | — | [V] |
| `@aws-sdk/lib-storage` `Upload` | `params.IfNoneMatch='*'` is spread into PutObject (small) and CompleteMultipartUpload (large) | Defaults CRC32 *composite* on MPU when `WHEN_SUPPORTED`; can pass `ChecksumAlgorithm`/`ChecksumSHA256` | n/a | [V] source (3.1096.0) |
| `gcloud storage cp` | `--if-generation-match=0` flag exists; `--no-clobber` “may perform an additional GET” (not a precondition) | — | `-I` paths from stdin; `-L` manifest log (resumable) | [V] / [I] for `=0` |
| `@google-cloud/storage` | `preconditionOpts: {ifGenerationMatch: 0}` | CRC32C/MD5 validation | TransferManager | [V] (docs sample) |

**Current blobsy state** (from `packages/blobsy/src/`):

- `BuiltinS3Backend.push` uses lib-storage `Upload` (8 MiB parts, concurrency 4). It
  sets no `IfNoneMatch` and no checksum, and leaves the SDK defaults on.
- `backend-aws-cli.ts` and `backend-rclone.ts` spawn one `aws s3 cp` or `rclone copyto`
  process per file with no conditional flags.
- `@aws-sdk/client-s3@3.995.0` keeps the post-Dec-2024 `WHEN_SUPPORTED` checksum
  default. Several S3-compatibles reject those headers (B2 [S], older R2 [S]).

## 5. Patterns blobsy should adopt

### 5.1 P1 — Create-only push enforces the immutability invariant (all UCs)

- Every blob upload sends create-only:
  - built-in S3: `IfNoneMatch: '*'` in `Upload` params
  - aws-cli: `--no-overwrite`
  - rclone S3: `--header-upload "If-None-Match: *"`
  - GCS native: `ifGenerationMatch=0`
  - Azure: `If-None-Match: *`
- **Map `412` to “already published.”** For content-addressed keys (`sha256/…`,
  `{content_sha256}/…`), HEAD the object and verify size plus stored checksum (§5.2). If
  they match, report success, so the operation stays idempotent across retries and
  concurrent pushers. If they differ, it is a hard error: the store contains different
  bytes under a content key.
  For path-shaped keys (`shared/{repo_path}`, mirror mode), `412` is a real conflict.
  Refuse it, consistent with R12 (“remote-side deletion is forbidden”) and with the
  invariant.
- **Capability detection in `blobsy doctor`:** probe once per backend with a create-only
  PUT of a sentinel key written twice.
  Expect `200` then `412`. Treat `400`/`501` (B2, OVH-style) and `200`/`200` (header
  silently ignored) as **unsupported**, and fall back to HEAD-then-PUT with a warning
  that the invariant is advisory there.
  Record the result in doctor output.
- **Optional hardening, documented for operators:** an S3 bucket policy that denies
  PutObject without `s3:if-none-match` (the AWS sample exempts MPU create/part calls via
  `s3:ObjectCreationOperation`) [V]. This makes the invariant hold even against other
  tools. Caveat: the enforce page still says conditional CopyObject returns `501`, which
  conflicts with the 2025-10-29 launch.
  Test before recommending it.
- **Known gap:** blobsy’s `gs://` and `azure://` go through rclone, which cannot send
  preconditions. Options: (a) accept advisory immutability on GCS/Azure via `--immutable`
  (racy); (b) add a thin native create-only write (`@google-cloud/storage` /
  `@azure/storage-blob`) for manifests and receipts only, where races matter most; (c)
  send an upstream rclone patch mapping `If-None-Match: *` → `ifGenerationMatch=0` /
  Azure `If-None-Match`. Prefer (b) now, plus (c).

### 5.2 P2 — Provider checksum at upload, verify by HEAD (UC-1, UC-2, UC-5)

- **S3, single-part:** send `ChecksumSHA256` = base64 of the SHA-256 that blobsy already
  computes. S3 validates it server-side and stores it.
  `HeadObject` with `ChecksumMode: 'ENABLED'` returns it.
  Remote verification is then one HEAD per blob, with no download and no second hash
  algorithm [V]. This only matches the `.bref` hash when the stored bytes equal the
  hashed bytes. With compression, the `.bref` must also carry the stored-object hash, or
  blobsy must compare the compressed hash.

- **S3, multipart (> part threshold):** SHA-256 becomes composite.
  Either (a) use `ChecksumType: FULL_OBJECT` with CRC64NVME and record that CRC in the
  `.bref` or receipt for HEAD comparison, or (b) raise the single-PUT ceiling (S3 allows
  up to 5 GB per PUT) so that most blobs stay SHA-256-verifiable.
  Recommend (a) for objects over about 1 GB and (b) otherwise.

- **Everyone else:** store the provider’s native fingerprint at push time in the receipt
  or `.bref` metadata:
  - GCS: CRC32C, plus MD5 when non-composite
  - Azure: client-set `x-ms-blob-content-md5`, *always set by blobsy*
  - R2: CRC64NVME full-object
  - B2: SHA-1 or `large_file_sha1`

  `verify --remote` then compares HEAD output to the recorded value.
  The provider-independent SHA-256 remains canonical; this only confirms what the
  provider stored.

- **Bulk audit (UC-2/UC-5 on S3):** Batch Operations Compute checksum produces
  full-object SHA-256 for any object, including multipart, without egress.
  Cost: ~$0.004/GB + $0.25/job + $1/M objects [V]. Worth documenting as `blobsy verify
  --remote --deep` guidance, not as an automatic step.

- **Compatibility setting:** expose `checksum_mode: when_required` per backend.
  It sets `requestChecksumCalculation`/`responseChecksumValidation` to `WHEN_REQUIRED`
  for S3-compatibles that reject the Dec-2024 default headers [V setting / S breakage].

### 5.3 P3 — Manifest/receipt-last publish (UC-2, mirror mode, UC-3)

No store commits multiple objects atomically, so commit by ordering:

1. Upload all content objects create-only (P1). They are invisible to readers until
   referenced.
2. Verify, at minimum by size via the PUT responses or listing; stronger with P2
   checksums.
3. **Write the manifest or receipt last, create-only, under an immutable name.**
   Example: `…/manifests/<tree_sha256>.json` or
   `…/.blobsy/receipts/<pushed_at>-<tree_hash>.yaml`. Its existence is the commit point.
   A crash before step 3 leaves orphan blobs, which GC handles, but never a manifest
   that references missing data.
   The Feb atomic-writes research already argued this; conditional writes now make it
   race-safe.
4. Optionally move a mutable pointer (`…/LATEST`, `RUN-STATUS`) with CAS:
   `If-Match: <etag-read>` (S3, R2, Tigris, Azure, MinIO) or `ifGenerationMatch=<gen>`
   (GCS). On `412`, re-read and re-decide; never blind overwrite.
   Readers resolve pointer → immutable manifest → immutable blobs.
   This is how Iceberg and Delta commit; blobsy does not need S3 Tables for it.

For UC-2 the git-committed manifest *is* the pointer.
Git provides the CAS, through merge, so step 4 is unnecessary.
The remote copy of the manifest should still be written create-only under its hash.

For Round-8 mirror mode (path-shaped keys): receipts satisfy R4 and R12 when written
create-only with a unique name.
A mutable “current receipt” must use CAS. On Tigris global or dual-region buckets,
conditionals are only regionally consistent.
Mirror receipts need single- or multi-region buckets there [V].

### 5.4 P4 — Pack many small files for UC-3 (and offer it for UC-2)

- Request cost per **1M objects** (one PUT each; Standard tier):
  - S3: $5.00
  - GCS regional: $5.00 (HNS: $6.50)
  - R2: $4.50
  - Tigris: ~$5.00 [I]
  - S3 Express One Zone: ~$1.13 + $0.0032/GB [S]
  - Azure Hot: ~$5–6.5 [S]
  - B2, Wasabi: $0

  A HEAD-verify pass adds ~$0.36–0.40 per 1M on S3, GCS, and R2. Listing is negligible
  in dollars (1k keys per page) but serial in latency.

- Approximate latency at a 64-way parallel rate of ~10 req/s per stream: about 26 min
  per 1M PUTs [I]. blobsy’s current process-per-file spawning adds roughly 100–300 ms of
  process startup per file [I], so it is **unusable** above ~10k files.

- `node_modules`, `target/`, and build caches (UC-3) are typically 10⁵–10⁶ files at
  small average size. Packing to `tar`+zstd shards of 64–256 MB turns 1M requests into
  hundreds and makes a cache refresh cost cents.
  Key shards by content hash (`cache/<tool>/<input_hash>/<shard_sha256>.tar.zst`).
  Shards are then immutable UC-5 assets (P1 applies) and the index is a manifest (P3).
  Avoid IA/Glacier-IR/Azure Cool tiers for small unpacked objects (128 KB/KiB minimum
  billable size).

- For UC-2 trees that must stay individually addressable (R9 browsability), use **one
  transfer process per batch**:
  - rclone: `copy --files-from0 list --no-traverse --transfers 32 --checkers 64`
    (`--files-from0` since v1.75.0 [V])
  - GCS: `gcloud storage cp -I` with `-L manifest.log` for resumability [V]
  - aws-cli: no `--files-from`; use `sync` with filters, or s5cmd (v2.2.x [S]) as an
    optional `command` backend.

### 5.5 P5 — Retention for UC-5 and safe GC

- UC-5 “fixed immutable assets with immutable names” map directly onto P1 plus
  store-side retention:
  - S3: Object Lock governance with default retention.
    The new **event holds** can express “keep until released, then N days” [V].
  - R2: a bucket-lock rule on the `assets/` prefix [V].
  - B2: Object Lock [V].
  - GCS: Bucket Lock or Retention Lock, not on HNS buckets [V].
  - Azure: version-level WORM [S].

  Because locks protect versions, not keys, P1 remains necessary to stop a second
  version appearing under an asset name.

- **GC safety:** use conditional delete `If-Match: <etag>` on S3 [V] or
  `ifGenerationMatch` on GCS [V], so GC deletes only the exact generation it judged
  unreferenced. Lock-protected prefixes make an erroneous GC fail closed.
  On GCS, either budget soft delete (7 days of deleted bytes) or set a 0-day soft delete
  policy on cache buckets [V].

- UC-3 caches: expiry by lifecycle rule (age, plus size on GCS), never by blobsy delete
  logic. This matches R10 (“growth bounded by lifecycle rule, not tooling”). Avoid Wasabi
  for short-TTL caches (90-day minimum).

## 6. Risks and gotchas

1. **“Supported” is not uniform.** Silent-ignore of `If-None-Match` would make P1 a
   no-op that looks successful.
   Only a doctor probe (write twice, expect `412`) proves it.
   B2 errors loudly [S]; R2 has no conditional CompleteMultipartUpload [V]. GCS XML
   multipart rejects preconditions [V]; Tigris global buckets evaluate conditions
   regionally [V].
2. **Delete markers defeat create-only on versioned S3.** If a key’s current version is
   a delete marker, a create-only PUT succeeds and “republishes” [V]. Pair it with R12’s
   no-remote-delete stance or Object Lock.
3. **`412` on retry of your own write.** SDK and tool retries after a lost response can
   hit `412` against the object they just wrote.
   Treat it as idempotent for content keys after HEAD verification (P1), never as fatal.
4. **Multipart plus delete gives `409`,** which requires restarting the whole multipart
   upload [V]. lib-storage aborts the MPU on error; blobsy should retry the whole upload
   once.
5. **Checksum defaults break S3-compatibles.** Post-Dec-2024 SDKs send CRC headers that
   B2 and some others reject [S]. JS SDK v3 defaults to CRC32 (composite on multipart),
   not CRC64NVME [V]. Do not assume a full-object CRC exists unless blobsy requested
   `ChecksumType: FULL_OBJECT`.
6. **Copy changes multipart checksums.** S3 CopyObject recomputes checksums as
   full-object, so a copied MPU object’s checksum value changes while its data does not
   [V]. Record checksum *type* alongside value.
7. **rclone version drift.** v1.73–v1.75 shipped several security fixes, including rc
   auth bypass and archive zip-slip, plus a serve-s3 auth-proxy breaking change [V].
   `blobsy doctor` should warn below v1.73.5 (for `--header-upload` conditionals, ≥
   v1.72.0).
8. **Bucket-policy enforcement blocks unconditioned tools.** Once a bucket requires
   `s3:if-none-match`, any `aws s3 sync` (which drops `--no-overwrite` to listing logic)
   or plain copy will get `403` [V]. Document this before recommending enforcement.
9. **GCS soft delete and churn.** UC-3 caches with daily turnover can add large bills:
   Google’s example is ~$460/mo for 100 TB/mo deleted [S]. HNS buckets cannot use the
   retention features UC-5 wants [V].
10. **MinIO for tests and self-hosting.** Upstream is archived; AIStor Free needs a
    license key [V]. A reported MinIO bug let conditional PUTs proceed without read
    quorum [S]. For blobsy’s integration tests, prefer an actively maintained
    S3-compatible server and verify its conditional-write behavior with the doctor
    probe. Candidates: Ceph RGW, SeaweedFS (claims conditional support [S]), Garage
    (partial S3 parity [S]).

## 7. Open questions / to verify by testing

- Wasabi and B2 actual behavior for `If-None-Match: *` today (probe; no vendor doc
  found).
- R2: is `If-None-Match` honored on CompleteMultipartUpload despite not being listed?
  Does PutObject with `x-amz-checksum-sha256` get stored and returned on HEAD?
- Does `gcloud storage cp --if-generation-match=0` work as create-only for both small
  and composite (parallel) uploads?
- AWS doc conflict: the enforce-policy page says conditional CopyObject returns `501`,
  while the 2025-10-29 launch says it is supported.
- Whether S3 annotations (2026-06) are a useful home for receipts on S3, given they are
  S3-only and are rejected on Object-Locked objects.

## 8. Sources

AWS S3:

- Conditional writes guide [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- Enforce conditional writes (bucket policy) [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html
- Launch, 2024-08-20 [V]:
  https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes
- `If-Match` + enforcement, 2024-11-25 [V]:
  https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes
- CopyObject conditionals, 2025-10-29 [V]:
  https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-s3-conditional-write-functionality-copy-operations
- Conditional deletes guide [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html
- Conditional deletes launch, 2025-09-16 [V]:
  https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-s3-conditional-deletes-s3-general-purpose-buckets
- Checking object integrity [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
- Checksums on upload (full-object vs composite table) [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Five new checksum algorithms, 2026-04-23 [V]:
  https://aws.amazon.com/about-aws/whats-new/2026/04/s3-five-additional-checksum-algorithms/
- Batch Ops Compute checksum [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/batch-ops-compute-checksums.html
- Compute checksum launch, 2025-08-18 [V]:
  https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-s3-verify-content-stored-datasets/
- SDK data-integrity defaults (per-SDK algorithm table) [V]:
  https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html
- Object Lock [V]:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
- Object Lock variable retention, 2026-09-08 [V]:
  https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-s3-object-lock-variable-retention/
- Express One Zone RenameObject, 2025-06-18 [V]:
  https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-s3-express-one-zone-atomic-renaming-objects-api
- Express One Zone price cut, 2025-04 [V]:
  https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-s3-express-one-zone-reduces-storage-request-prices/
- Annotations, 2026-06 [S]:
  https://aws.amazon.com/fr/about-aws/whats-new/2026/06/amazon-s3-annotations-business-context/
  and https://infoq.com/news/2026/07/aws-s3-annotations
- Pricing (Batch Ops, Compute checksum, 128 KB minimum) [V]:
  https://aws.amazon.com/s3/pricing/

aws-cli and SDK source:

- aws-cli v2 CHANGELOG (`--no-overwrite` in 2.33.0; checksum entries) [V]:
  https://github.com/aws/aws-cli/blob/v2/CHANGELOG.rst
- `_set_no_overwrite_param` → `IfNoneMatch="*"` [V]:
  https://github.com/aws/aws-cli/blob/v2/awscli/customizations/s3/utils.py
- Sync drops `no_overwrite` [V]:
  https://github.com/aws/aws-cli/blob/v2/awscli/customizations/s3/subcommands.py
- Vendored s3transfer: `IfNoneMatch` in `COMPLETE_MULTIPART_ARGS` [V]:
  https://github.com/aws/aws-cli/blob/v2/awscli/s3transfer/upload.py
- `aws s3 cp` reference (v2.38.4) [V]:
  https://docs.aws.amazon.com/cli/latest/reference/s3/cp.html
- `aws s3 sync` reference [V]:
  https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html
- `@aws-sdk/lib-storage` 3.1096.0 `dist-cjs/index.js` (params spread into Put, Create,
  and Complete) [V]: local `node_modules`.
- JS SDK checksum default breakage with third-party stores [S]:
  https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html
  and https://xcp-ng.org/forum/post/90304

Google Cloud Storage:

- Request preconditions [V]:
  https://docs.cloud.google.com/storage/docs/request-preconditions
- `gcloud storage cp` reference [V]:
  https://docs.cloud.google.com/sdk/gcloud/reference/storage/cp
- Release notes (2026 entries cited) [V]:
  https://docs.cloud.google.com/storage/docs/release-notes
- HNS overview (limitations, atomic rename) [V]:
  https://docs.cloud.google.com/storage/docs/hns-overview
- Soft delete [V]/[S]: https://docs.cloud.google.com/storage/docs/soft-delete and
  https://cloud.google.com/blog/products/storage-data-transfer/understanding-cloud-storages-new-soft-delete-feature
- Pricing [S]: https://cloud.google.com/storage/pricing

Azure:

- Conditional headers for Blob operations (updated 2026-01-20) [V]:
  https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations
- Put Blob (automatic MD5) [S]:
  https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob
- Version-level WORM [S]:
  https://learn.microsoft.com/azure/storage/blobs/immutable-version-level-worm-policies

Cloudflare R2:

- S3 API compatibility (conditionals, checksums, unimplemented ops) [V]:
  https://developers.cloudflare.com/r2/api/s3/api/
- Bucket locks [V]: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- Changelog [V]: https://developers.cloudflare.com/changelog/product/r2/
- Pricing [V]: https://developers.cloudflare.com/r2/pricing/

Backblaze B2:

- S3-compatible API (updated 2025-12-10) [V]:
  https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
- Object Lock [V]: https://www.backblaze.com/docs/cloud-storage-object-lock
- Pricing [V]: https://www.backblaze.com/cloud-storage/pricing
- Proxmox patch, B2 rejects `If-None-Match` (2025-07) [S]:
  https://lists.proxmox.com/pipermail/pbs-devel/2025-July/014234.html

Tigris:

- Conditionals [V]: https://www.tigrisdata.com/docs/objects/conditionals
- S3 compatibility [V]: https://www.tigrisdata.com/docs/api/s3/
- Features [V]: https://tigrisdata.com/docs/overview/features/

Wasabi:

- May 2026 pricing [V]: https://docs.wasabi.com/docs/may-2026-wasabi-pricing
- Minimum storage duration [V]:
  https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work
- Proxmox forum on conditional PUT support [S]:
  https://forum.proxmox.com/threads/proxmox-backup-server-s3-backend-%E2%80%93-%E2%80%9Cconditional-object-puts-are-not-supported%E2%80%9D-ovh-object-storage.169520/

MinIO:

- Repo README (archived 2026-04-25, source-only) [V]: https://github.com/minio/minio
- Conditional writes since 2023 [V]:
  https://www.min.io/blog/leading-the-way-minios-conditional-write-feature-for-modern-data-workloads
- Timeline and alternatives [S]:
  https://dev.to/rosgluk/minio-ce-in-2026-retired-upstream-source-only-and-what-to-use-1k02,
  https://linuxiac.com/minio-ends-active-development/, and
  https://blocksandfiles.com/2025/06/19/minio-removes-management-features-from-basic-community-edition-object-storage-code/

rclone:

- Changelog (v1.70–v1.75.2) [V]: https://rclone.org/changelog/ and
  https://github.com/rclone/rclone/blob/master/docs/content/changelog.md
- S3 backend source (`if-none-match` → PutObject and CompleteMultipartUpload) [V]:
  https://github.com/rclone/rclone/blob/master/backend/s3/s3.go
- GCS and Azure backend sources (no conditional mapping) [V]:
  https://github.com/rclone/rclone/blob/master/backend/googlecloudstorage/googlecloudstorage.go
  and https://github.com/rclone/rclone/blob/master/backend/azureblob/azureblob.go
- S3 docs (MD5 hashes, Object Lock flags) [V]: https://rclone.org/s3/
