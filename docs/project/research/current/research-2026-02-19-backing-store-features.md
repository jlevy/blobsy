# Research: Cloud Storage Backing Store Features

**Date:** 2026-02-19

**Status:** Reference

**Related:**

- [blobsy-design.md](../../design/blobsy-design.md) -- blobsy design document
- [research-2026-02-19-sync-tools-landscape.md](research-2026-02-19-sync-tools-landscape.md)
  -- companion research on sync tools, transport engines, and architecture options

## Overview

This research investigates the **backing store layer** for blobsy: cloud object storage
providers and their features relevant to syncing large files.
The key questions are whether any provider offers transparent compression, how sync
tools interact with each provider, and how providers compare on pricing, features, and
compatibility.

## Questions to Answer

1. Which storage providers offer transparent compression (compress on write, decompress
   on read)?
2. How does “decompressive transcoding” (GCS, R2) work, and is it useful for blobsy?
3. What are the sync tool capabilities per provider (`aws s3 sync`,
   `gcloud storage rsync`, `azcopy`, `rclone`)?
4. How do providers compare on pricing, features, S3 compatibility, and SDK support?
5. Should blobsy do client-side compression, or can it rely on the storage layer?
6. What automatic hashes/checksums does each provider compute, and can blobsy use them
   to verify if a local file matches a remote file without downloading it?

## Scope

- **Included:** AWS S3, Google Cloud Storage, Cloudflare R2, Azure Blob Storage,
  Backblaze B2, Tigris, DigitalOcean Spaces, Wasabi, MinIO (self-hosted)
- **Excluded:** Specialized ML platforms (HF Hub, Weights & Biases), databases, CDN-only
  services

## Part 1: Storage-Layer Compression

The central question: can blobsy delegate compression to the storage provider?

### 1.1 True Transparent Compression

Only one provider offers genuine transparent compression -- compress on write,
decompress on read, invisible to the S3 API client.

#### MinIO (Self-Hosted Only)

MinIO uses the **S2 algorithm** (an extension of Snappy by Klaus Post).
Objects are compressed in-flight before writing to disk on PUT and decompressed
in-flight on GET. Clients interact via standard S3 API and see only uncompressed data.

**Performance (Silesia corpus benchmarks):**

| S2 Mode | Compression Speed | Ratio | Decompression Speed |
| --- | --- | --- | --- |
| Default | ~15,148 MB/s | ~83% of original | ~2,378 MB/s |
| Better | ~11,551 MB/s | ~85% of original | ~2,300 MB/s |
| Best | ~680 MB/s | ~87% of original | ~2,572 MB/s |

In production: write throughput ~500+ MB/s per CPU core, decompression ~1+ GB/s per
core. On spinning disks, compression can actually increase overall throughput because
reduced I/O outweighs CPU cost.

**Configuration:** Global only (not per-bucket, not per-object).
Enabled via environment variables:

```bash
MINIO_COMPRESSION_ENABLE=on
MINIO_COMPRESSION_EXTENSIONS=".txt,.log,.csv,.json,.tar,.xml,.bin"
MINIO_COMPRESSION_MIME_TYPES="text/*,application/json,application/xml"
```

Already-compressed formats (gz, bz2, rar, zip, 7z, xz, mp4, mkv, mov) and incompressible
MIME types (video/\*, audio/\*, application/zip) are automatically excluded.

**Range request support:** MinIO builds an internal index for compressed objects (parts
exceeding 8 MB), mapping uncompressed byte offsets to compressed offsets.
Efficient byte-range retrieval is supported.

**ETag problem:** When compression is enabled, the ETag is **not** the MD5 of the
uncompressed content.
This breaks sync tools that rely on ETag/MD5 for integrity verification.
`aws s3 sync` uses size + mtime (not ETags) by default, so it works.
But `rclone` and cross-provider replication encounter mismatches.

**Compression + encryption:** Disabled by default due to CRIME-style TLS attacks.
Must be explicitly enabled with `allow_encryption=on`. When enabled, MinIO pads
compressed output to 256-byte multiples to obscure size information.

**Bottom line:** MinIO proves transparent compression works at the storage layer.
But it’s self-hosted only, which limits relevance for blobsy’s primary use case (hosted
cloud storage).

#### All Other Providers: No Transparent Compression

| Provider | Storage-Layer Compression |
| --- | --- |
| AWS S3 | None. “If you store compressed content, Amazon S3 will serve compressed content.” |
| Google Cloud Storage | None at storage layer (decompressive transcoding is different -- see 1.2) |
| Cloudflare R2 | None at storage layer |
| Azure Blob Storage | None |
| Backblaze B2 | None |
| Tigris | None |
| DigitalOcean Spaces | None (CDN layer does dynamic compression, but not storage) |
| Wasabi | Explicitly states no compression or deduplication |

### 1.2 Decompressive Transcoding (Store Compressed, Serve Decompressed)

Some providers offer a half-measure: if you upload pre-compressed data with the right
HTTP headers, they’ll decompress on read for clients that don’t request compressed
content. This is fundamentally different from transparent compression -- **you still
compress before upload**.

#### Google Cloud Storage

**Triggering conditions (all must be true):**

1. Object was uploaded as gzip-compressed data
2. Object has `Content-Encoding: gzip` metadata set
3. Object has a valid `Content-Type` set
4. Object does NOT have `Cache-Control: no-transform` set
5. Client request does NOT include `Accept-Encoding: gzip`

**What happens when transcoding activates:**

- GCS decompresses the object on the fly during download
- The `Content-Encoding` header is removed from the response
- The `Content-Length` header reflects the decompressed size (or is absent)

**Critical limitations:**

| Limitation | Impact |
| --- | --- |
| **Checksums invalidated** | CRC32C and MD5 stored on the object are for compressed bytes. After transcoding, integrity verification fails. |
| **Range requests silently ignored** | Entire object is served instead of requested range. No error returned. |
| **Only gzip** | No zstd, lz4, brotli. |
| **Billing on decompressed size** | Egress charges based on decompressed size. Storage savings partially offset by higher egress. |
| **Sync tools confused** | `gcloud storage rsync` may discard `Content-Encoding` metadata. `rclone` has had issues with GCS decompressive transcoding. |

**Prevention:**

- Send `Accept-Encoding: gzip` (receive compressed bytes as-is)
- Upload with `Cache-Control: no-transform` (prevents transcoding for all clients)
- Don’t set `Content-Encoding: gzip` in the first place

#### Cloudflare R2

Similar behavior to GCS: objects stored with `Content-Encoding: gzip` are transparently
decompressed for clients that don’t send `Accept-Encoding: gzip`.

**R2-specific issues:** In rclone v1.68.1, an AWS SDK upgrade changed `Accept-Encoding`
behavior from `gzip` to `identity`, causing R2 to transparently decompress and breaking
size verification. The fix is uploading with `Cache-Control: no-transform`.

#### AWS S3

**S3 does NOT perform decompressive transcoding.** Objects are served exactly as stored.
Some AWS SDK versions (Go SDK v2) will auto-decompress responses with
`Content-Encoding: gzip`, but this is the HTTP client, not S3.

CloudFront (CDN) can compress on-the-fly, but this is a CDN feature, not storage.

### 1.3 Transfer/Streaming Compression

**No provider compresses data in transit** beyond TLS encryption.
Specifically:

- S3 does not honor `Accept-Encoding` for on-the-fly compression
- S3 still uses **HTTP/1.1** for object transfers (GCS uses HTTP/2)
- TLS compression is disabled due to CRIME/BREACH attacks
- No provider compresses request/response bodies at the API layer

### 1.4 Assessment: Why Client-Side Compression Is the Right Approach

No hosted provider offers transparent compression that would eliminate the need for
client-side compression.
The landscape is clear:

| Approach | Provider Support | Impact on Sync Tools | Recommendation |
| --- | --- | --- | --- |
| **Transparent (MinIO-style)** | Self-hosted only | ETags break, cross-provider replication fails | Not portable enough |
| **Decompressive transcoding (GCS/R2)** | GCS, R2 | Range requests break, checksums invalidated, billing surprises | Avoid -- too many edge cases |
| **Client-side compression** | Works with all providers | Adds `.zst` extension, changes file size; blobsy manages the mapping | The portable solution |
| **No compression** | Works with all providers | Maximum simplicity, `aws s3 sync` delegation works perfectly | Simplest option |

**The blobsy design should treat compression as a client-side concern.** Files stored
with `.zst` extensions (not HTTP `Content-Encoding` headers) avoid all provider-specific
decompressive transcoding edge cases.
The skip_extensions list for already-compressed formats is essential.

For users running MinIO, they can enable server-side compression AND set
`compression: none` in blobsy config for the best of both worlds.

## Part 2: Provider Feature Comparison

### 2.1 AWS S3

**The baseline.** Every other provider defines itself relative to S3.

| Feature | Details |
| --- | --- |
| **API** | S3 REST API (native) |
| **Storage classes** | Standard, Intelligent-Tiering, Standard-IA, One Zone-IA, Glacier Instant, Glacier Flexible, Glacier Deep, Express One Zone |
| **Versioning** | Yes (opt-in per bucket) |
| **Lifecycle rules** | Full featured (transitions, expiration, abort incomplete multipart) |
| **Object Lock** | Yes (WORM compliance) |
| **Server-side encryption** | SSE-S3, SSE-KMS, SSE-C |
| **Max object size** | 5 TB |
| **S3 Select** | Yes (query data in place) |
| **HTTP protocol** | HTTP/1.1 |
| **Sync tool** | `aws s3 sync` (size + mtime change detection) |
| **Node.js SDK** | `@aws-sdk/client-s3` (mature, streaming, multipart) |
| **Auth** | IAM credentials, instance profiles, SSO, OIDC federation |

**Pricing (us-east-1, Standard):**

| Item | Cost |
| --- | --- |
| Storage | $0.023/GB/month |
| PUT/COPY/POST/LIST | $0.005 per 1,000 |
| GET/SELECT | $0.0004 per 1,000 |
| Egress (first 10 TB) | $0.09/GB (first 100 GB/month free, shared across all AWS services) |
| Free tier | 5 GB storage for 12 months; 100 GB data transfer out/month (always free) |

### 2.2 Google Cloud Storage

**Best-in-class tooling and checksum-based sync, but higher egress costs.**

| Feature | Details |
| --- | --- |
| **API** | JSON API (native) + XML API (S3-compatible with HMAC keys) |
| **S3 compatibility** | Via XML API at `storage.googleapis.com`. PutObject, GetObject, DeleteObject, multipart uploads all work. Lifecycle XML and ACL syntax differ. |
| **Storage classes** | Standard, Nearline (30d), Coldline (90d), Archive (365d) |
| **Autoclass** | Auto-transitions objects between classes based on access patterns |
| **Versioning** | Yes (opt-in) |
| **Object composition** | Compose up to 32 objects server-side (no data transfer) |
| **Parallel composite uploads** | Auto-split large files into chunks, upload in parallel, compose server-side |
| **Turbo replication** | 15-minute RPO for dual-region buckets (SLA-backed) |
| **Decompressive transcoding** | Yes -- see Section 1.2 (not recommended for blobsy) |
| **HTTP protocol** | HTTP/2 |
| **Sync tool** | `gcloud storage rsync` (checksums or mtime; `gsutil` is deprecated) |
| **Node.js SDK** | `@google-cloud/storage` (mature, streaming, resumable uploads, TransferManager for parallel ops) |
| **Auth** | Application Default Credentials, service account keys, Workload Identity Federation, HMAC keys (for S3 compat) |

**Change detection (`gcloud storage rsync`):**

1. Local-to-cloud: size + mtime (like `aws s3 sync`)
2. Cloud-to-cloud: checksums (MD5 or CRC32C)
3. Override with `--checksums-only` to force checksum comparison

**Important:** After `git checkout`, mtime resets on all files.
`gcloud storage rsync` would consider everything “changed” and re-upload.
This is exactly the problem blobsy’s manifest-based SHA-256 change detection solves.

**Pricing (Standard):**

| Item | Single Region (us-east1) | US Multi-Region |
| --- | --- | --- |
| Storage | $0.020/GB/month | $0.026/GB/month |
| Class A ops (PUT/LIST) | $0.05 per 10,000 | $0.10 per 10,000 |
| Class B ops (GET/HEAD) | $0.004 per 10,000 | $0.004 per 10,000 |
| Egress (first 1 TB) | ~$0.12/GB (Premium tier) | ~$0.12/GB (Premium tier) |
| Free tier | 5 GB (always free, not time-limited); 100 GB egress/month |  |

**Note:** Multi-region Class A ops doubled from $0.05 to $0.10 per 10,000 in April 2023.
For most blobsy use cases, single-region is the better value.

**Multipart upload limitation:** Composite objects (from multipart upload) only have
CRC32C hashes, not MD5. Not a problem for blobsy (uses SHA-256 independently).

**blobsy integration path:** Use `type: s3` with HMAC keys and
`endpoint: https://storage.googleapis.com` for V1. No new backend type needed.
A future native `type: gcs` backend would enable ADC auth and parallel composite
uploads.

### 2.3 Azure Blob Storage

**Different API model.
Requires dedicated backend support, not S3-compatible.**

| Feature | Details |
| --- | --- |
| **API** | Azure Blob REST API (NOT S3-compatible) |
| **S3 compatibility** | None. Third-party gateways exist but add latency and complexity. |
| **Resource model** | Storage Account -> Container -> Blob (vs. S3’s flat Bucket -> Object) |
| **Blob types** | Block Blobs (general), Append Blobs (logging), Page Blobs (VM disks) |
| **Access tiers** | Hot, Cool (30d), Cold (90d), Archive (180d, hours to rehydrate) |
| **Smart tier** | Auto-moves between Hot/Cool/Cold based on usage (unique to Azure) |
| **Hierarchical namespace** | Optional true directory semantics with atomic rename (Data Lake Gen2) |
| **Immutability** | WORM policies at container or version level |
| **Compression** | None at any layer |
| **Sync tool** | `azcopy sync` (mtime or MD5-based change detection) |
| **Node.js SDK** | `@azure/storage-blob` v12.x (mature, streaming, parallel uploads) |
| **Auth** | Entra ID (Azure AD), Shared Key, SAS tokens, Managed Identity |

**azcopy change detection:**

- Default: file names + last modified timestamps
- `--compare-hash`: MD5 hash comparison (more reliable, slower)
- Single azcopy instance per machine recommended; use `AZCOPY_CONCURRENCY_VALUE` for
  parallelism

**Pricing (Hot tier, LRS, US East):**

| Item | Cost |
| --- | --- |
| Storage (first 50 TB) | $0.018/GB/month |
| Write (PUT/POST) | $0.005 per 10,000 |
| Read (GET) | $0.0004 per 10,000 |
| Egress (5 GB - 10 TB) | $0.087/GB |
| Free tier | 5 GB for 12 months |

**blobsy integration path:** Cannot use `type: s3`. Needs a distinct `type: azure-blob`
backend. Lowest-effort path is via `sync.tool: rclone` (rclone has native `azureblob`
backend). For `built-in` engine, add `@azure/storage-blob` as an optional dependency.

### 2.4 Cloudflare R2

**Zero egress fees. Simple pricing.
Good S3 compatibility.**

| Feature | Details |
| --- | --- |
| **API** | S3-compatible |
| **S3 compatibility** | Good. Works with `--endpoint-url` on aws-cli, rclone, and SDKs. |
| **Storage classes** | Standard ($0.015/GB), Infrequent Access ($0.01/GB, 30d min, $0.01/GB retrieval) |
| **Versioning** | Yes |
| **Lifecycle rules** | Standard -> IA only (one-way). IA -> Standard requires CopyObject. |
| **Decompressive transcoding** | Yes -- same as GCS. Avoid for blobsy. |
| **Compression** | None at storage layer |
| **Sync tool** | `aws s3 sync` with `--endpoint-url`, rclone |
| **Node.js SDK** | Uses `@aws-sdk/client-s3` with R2 endpoint |
| **Auth** | R2 API tokens (access key + secret key, S3-style) |

**Pricing:**

| Item | Cost |
| --- | --- |
| Storage (Standard) | $0.015/GB/month |
| Storage (Infrequent Access) | $0.01/GB/month (30d min, $0.01/GB retrieval) |
| Egress | **$0 (free)** |
| Class A ops (PUT/LIST) | $4.50 per million ($0.045 per 10,000) |
| Class A ops (IA) | $9.00 per million ($0.09 per 10,000) |
| Class B ops (GET) | $0.36 per million ($0.0036 per 10,000) |
| Class B ops (IA) | $0.90 per million ($0.009 per 10,000) |
| Free tier | 10 GB storage, 1M Class A, 10M Class B per month (Standard only) |

**blobsy integration:** Works with `type: s3` and custom endpoint.
Already covered by the design.

### 2.5 Backblaze B2

**Cheapest raw storage.
Generous free egress.
Free uploads.**

| Feature | Details |
| --- | --- |
| **API** | S3-compatible (v4 signatures only) + native B2 API |
| **S3 compatibility** | Good for core operations. No object tagging. Limited ACLs. |
| **Versioning** | Always on (cannot disable) |
| **Compression** | None |
| **Egress** | Free up to 3x average monthly storage; $0.01/GB over. Free to Cloudflare (Bandwidth Alliance). |
| **Sync tools** | `aws s3 sync --endpoint-url`, rclone (both B2 native and S3 backends), B2 CLI |
| **Auth** | Application keys (access key + secret key) |

**Pricing:**

| Item | Cost |
| --- | --- |
| Storage | $0.005/GB/month ($5/TB) |
| PUT/POST/upload | **Free** |
| GET/HEAD/download | First 2,500/day free, then $0.004 per 10,000 |
| LIST | First 2,500/day free, then $0.004 per 1,000 |
| Free tier | 10 GB storage |

**blobsy integration:** Works with `type: s3` and custom endpoint.

### 2.6 Wasabi

**Claims 100% S3 compatibility.
Cheap storage. Hidden constraints.**

| Feature | Details |
| --- | --- |
| **API** | S3-compatible ("100% bit-compatible" claim) |
| **S3 compatibility** | Excellent. Object Lock, versioning, lifecycle rules all supported. |
| **Compression** | Explicitly none. No dedup either. |
| **Sync tools** | `aws s3 sync --endpoint-url`, rclone (named provider) |

**Pricing:**

| Item | Cost |
| --- | --- |
| Storage | ~$0.007/GB/month ($6.99/TB) |
| Egress | **Free** (with 1:1 ratio cap -- downloads must not exceed stored data volume) |
| API operations | **Free** |
| Minimum monthly charge | $6.99/month (1 TB minimum) |
| **Minimum retention** | **90 days (PAYG)**, 30 days (RCS) |

**Warning for file sync:** The 90-day minimum retention means every version of a file
that gets pushed incurs at least 90 days of storage charges, even if overwritten the
next day. This makes Wasabi poorly suited for workloads with frequent changes.
The 1 TB minimum monthly charge is also a barrier for small projects.

### 2.7 Tigris (fly.io)

**Globally distributed.
Zero egress. No versioning.**

| Feature | Details |
| --- | --- |
| **API** | S3-compatible (endpoint: `https://t3.storage.dev`) |
| **S3 compatibility** | Good minus **no versioning** (GetBucketVersioning, ListObjectVersions unsupported) |
| **Unique feature** | Automatic geo-distribution: data stored near writers, cached near readers |
| **Compression** | None |
| **Sync tools** | `aws s3 sync --endpoint-url`, rclone (as generic S3 provider) |

**Pricing:**

| Item | Cost |
| --- | --- |
| Storage (Standard) | $0.02/GB/month |
| Egress | **Free** |
| Class A ops | $0.005 per 1,000 |
| Class B ops | $0.0005 per 1,000 |
| Free tier | 5 GB, 10K Class A, 100K Class B per month |

**Maturity:** Production-grade since 2025. Series A ($25M, Spark Capital).
Used by fal.ai, Hedra, Railway.

**blobsy integration:** Works with `type: s3` and custom endpoint.
Lack of versioning is a limitation but not blocking for blobsy (blobsy manages its own
versioning via pointer files and namespaces).

### 2.8 DigitalOcean Spaces

**Simple flat pricing with built-in CDN. Rate-limited.**

| Feature | Details |
| --- | --- |
| **API** | S3-compatible |
| **S3 compatibility** | Good. `list-objects-v2` pagination not supported. |
| **CDN** | Built-in, no extra cost. CDN does dynamic gzip compression. |
| **Rate limits** | 800 ops/sec per bucket (new buckets); 500 ops/sec (legacy) |
| **Compression** | None at origin. CDN layer compresses dynamically. |
| **Sync tools** | `aws s3 sync --endpoint-url`, rclone (named provider) |

**Pricing:**

| Item | Cost |
| --- | --- |
| Base | $5/month (includes 250 GiB storage + 1 TiB egress) |
| Additional storage | $0.02/GiB/month |
| Additional egress | $0.01/GiB |
| Cold Storage | $0.007/GiB/month |
| API operations | Included |

## Part 3: Provider Comparison Matrix

### 3.1 Pricing Comparison

| Provider | Storage $/GB/mo | Egress $/GB | PUT/10K | GET/10K | Free Tier | Min Charge |
| --- | --- | --- | --- | --- | --- | --- |
| **AWS S3** | $0.023 | $0.09 | $0.05 | $0.004 | 5 GB (12 mo) + 100 GB egress/mo | None |
| **GCS** (single region) | $0.020 | ~$0.12 | $0.05 | $0.004 | 5 GB (always) + 100 GB egress/mo | None |
| **GCS** (multi-region) | $0.026 | ~$0.12 | $0.10 | $0.004 | (same) | None |
| **Azure Blob** | $0.018 | $0.087 | $0.05 | $0.004 | 5 GB (12 mo) | None |
| **Cloudflare R2** | $0.015 | **$0** | $0.045 | $0.0036 | 10 GB | None |
| **Backblaze B2** | $0.005 | Free (3x) | **$0** | $0.004 | 10 GB | None |
| **Wasabi** | ~$0.007 | Free (1:1) | **$0** | **$0** | None | $6.99/mo |
| **Tigris** | $0.02 | **$0** | $0.05 | $0.005 | 5 GB | None |
| **DO Spaces** | $0.02 | $0.01 | Incl. | Incl. | None | $5/mo |

### 3.2 Feature Comparison

| Feature | S3 | GCS | Azure | R2 | B2 | Wasabi | Tigris | DO Spaces |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **S3 API** | Native | Via XML API | No | Yes | Yes | Yes | Yes | Yes |
| **Versioning** | Yes | Yes | Yes | Yes | Always on | Yes | **No** | Yes |
| **Lifecycle** | Full | Full | Full | Limited | Limited | Full | Yes | Yes |
| **Object Lock** | Yes | Retention | Yes | No | No | Yes | No | No |
| **Server compression** | No | No | No | No | No | No | No | No |
| **Decompressive transcoding** | No | Yes | No | Yes | No | No | No | No |
| **Geo-distribution** | Multi-AZ | Multi-region | LRS/ZRS/GRS | Global (CF) | Single region | Single region | **Auto** | Single + CDN |
| **HTTP protocol** | HTTP/1.1 | HTTP/2 | HTTP/1.1 | HTTP/2 | HTTP/1.1 | HTTP/1.1 | Unknown | HTTP/1.1 |
| **Min retention** | None | None | None | None | None | **90 days** | None | None |

### 3.3 Sync Tool Compatibility

| Provider | `aws s3 sync` | `gcloud rsync` | `azcopy` | `rclone` | Built-in SDK |
| --- | --- | --- | --- | --- | --- |
| **AWS S3** | Native | N/A | N/A | Yes | `@aws-sdk/client-s3` |
| **GCS** | Via endpoint | Native | N/A | Yes (native) | `@google-cloud/storage` |
| **Azure Blob** | No | No | Native | Yes (native) | `@azure/storage-blob` |
| **R2** | Via endpoint | N/A | N/A | Yes (named) | `@aws-sdk/client-s3` + endpoint |
| **B2** | Via endpoint | N/A | N/A | Yes (both) | `@aws-sdk/client-s3` + endpoint |
| **Wasabi** | Via endpoint | N/A | N/A | Yes (named) | `@aws-sdk/client-s3` + endpoint |
| **Tigris** | Via endpoint | N/A | N/A | Yes (generic S3) | `@aws-sdk/client-s3` + endpoint |
| **DO Spaces** | Via endpoint | N/A | N/A | Yes (named) | `@aws-sdk/client-s3` + endpoint |

### 3.4 Authentication Models

| Provider | Credential Chain | CI/CD Integration |
| --- | --- | --- |
| **AWS S3** | Env vars -> `~/.aws/credentials` -> instance profile -> SSO | OIDC federation (GitHub Actions, GitLab) |
| **GCS** | `GOOGLE_APPLICATION_CREDENTIALS` -> ADC file -> metadata server | Workload Identity Federation (GitHub Actions) |
| **Azure Blob** | Env vars -> Managed Identity -> `az login` | Service Principal, Workload Identity |
| **R2** | R2 API tokens (access key + secret) | Environment variables |
| **B2** | Application keys (access key + secret) | Environment variables |
| **Wasabi** | Access key + secret key | Environment variables |
| **Tigris** | Access key + secret key (via fly.io) | Environment variables |
| **DO Spaces** | Access key + secret key | Environment variables |

## Part 4: Compression Economics

### 4.1 Compression Ratios by Data Type (zstd Level 3)

| Data Type | Ratio | Compressed Size | Notes |
| --- | --- | --- | --- |
| JSON | ~8-12x | 8-12% of original | Highly structured, very compressible |
| CSV | ~4-8x | 12-25% of original | Depends on data entropy |
| Plain text / logs | ~4-7x | 14-25% of original | Excellent for structured logs |
| Parquet (uncompressed) | ~3-5x | 20-33% of original | Columnar, still compressible |
| Parquet (Snappy) | ~1.3-1.5x | 65-80% of original | Marginal improvement |
| Binary / model weights | ~1.5-3x | 33-65% of original | Varies widely |
| Images (JPEG/PNG) | ~1.0x | ~100% | Already compressed |
| Video (MP4) | ~1.0x | ~100% | Already compressed |

### 4.2 Storage Cost Savings (S3 Standard, zstd-3 ~3x Ratio)

| Dataset Size | Monthly Uncompressed | Monthly Compressed | Savings |
| --- | --- | --- | --- |
| 10 GB | $0.23 | $0.08 | $0.15 |
| 100 GB | $2.30 | $0.77 | $1.53 |
| 1 TB | $23.00 | $7.67 | $15.33 |
| 10 TB | $230.00 | $76.67 | $153.33 |
| 100 TB | $2,300.00 | $766.67 | $1,533.33 |

**Egress costs matter more than storage costs.** S3 egress is $0.09/GB. For a 1 TB
dataset pulled 10 times/month, compression saves ~$600/month in egress alone (vs.
~$15/month in storage savings).

### 4.3 When Compression Justifies Complexity

**Always worth it:**

- Text-heavy datasets (JSON, CSV, logs, markdown): 3-10x compression, near-zero CPU
  overhead at zstd level 1-3
- Repeated sync of the same datasets: egress savings compound
- Slow or metered networks: compressed transfer is faster

**Marginal:**

- Datasets under ~1 GB: savings are pennies
- Mixed datasets with mostly pre-compressed formats

**Not worth it:**

- Already-compressed data (the blobsy `skip_extensions` list handles this)
- Latency-sensitive single-file operations

### 4.4 Compression Performance vs Network Throughput

zstd-3 compresses at ~500 MB/s per core.
On a 1 Gbps link (125 MB/s), compressing a 1 GB file to 333 MB:

- Compress time: ~2 seconds
- Transfer time (uncompressed): ~8 seconds
- Transfer time (compressed): ~2.7 seconds
- **Total with compression: ~4.7 seconds.
  Without: ~8 seconds.**

Compression is a net performance win on any link slower than ~4 Gbps (nearly all links).
Decompression at ~1 GB/s is essentially free.

### 4.5 The Sync Delegation Tradeoff

Client-side compression conflicts with full sync delegation:

| Scenario | `aws s3 sync` delegation? |
| --- | --- |
| `compression: none` | Yes -- `aws s3 sync ./local/ s3://bucket/prefix/` just works |
| `compression: zstd` | No -- blobsy must compress to temp dir, then sync the temp dir, or manage individual uploads |

With `compression: none`, blobsy can truly delegate directory sync to the transport
tool. With compression enabled, blobsy must mediate every file transfer (compress before
upload, decompress after download), and the “transparent storage format” goal is
partially compromised (remote has `.zst` files).

**Design recommendation:** Default to `compression: none` for maximum simplicity and
sync delegation compatibility.
Make compression opt-in for users who prioritize storage/egress cost savings and accept
the added complexity.

## Part 5: Automatic Hashes and Remote Verification

A key question for blobsy: can you check if a local file matches a remote file **without
downloading it**? This depends on what hashes each provider computes automatically and
whether those hashes are retrievable via metadata APIs.

### 5.1 Hash Support by Provider

| Provider | Auto Hash on Upload | Retrievable via HEAD | Multipart Upload Hash | Notes |
| --- | --- | --- | --- | --- |
| **AWS S3** | CRC64NVME (default since late 2024) | Yes (`x-amz-checksum-*` headers) | Composite checksum (not whole-file) | Can also request SHA-256, CRC32C, SHA-1, CRC32 at upload time |
| **GCS** | CRC32C (always) + MD5 (non-composite only) | Yes (object metadata) | CRC32C only (no MD5 for composite objects) | CRC32C is the recommended algorithm |
| **Azure Blob** | MD5 (PutBlob only, not PutBlock/PutBlockList) | Yes (`Content-MD5` property) | **None automatic** -- client must calculate and set `x-ms-blob-content-md5` | Large files via block upload have no server-computed hash |
| **Cloudflare R2** | MD5 (non-multipart) | Yes (ETag = MD5 for single uploads) | Composite ETag (not MD5 of whole file) | Also supports SHA-256, SHA-1, CRC64NVME if specified at upload |
| **Backblaze B2** | SHA-1 (per part) | Yes (`X-Bz-Content-Sha1`) | **No whole-file hash** -- each part has SHA-1, but large file returns `none` | Can optionally set `large_file_sha1` in metadata |
| **Wasabi** | MD5 (ETag, non-multipart) | Yes (ETag) | Composite ETag | Claims 100% S3 compatibility for checksum behavior |
| **Tigris** | MD5 (ETag, non-multipart) | Yes (ETag) | Composite ETag | S3-compatible behavior |
| **DO Spaces** | MD5 (ETag, non-multipart) | Yes (ETag) | Composite ETag | S3-compatible behavior |

### 5.2 AWS S3: The Most Comprehensive

S3 has the most advanced checksum support of any provider, significantly improved in
2024-2025:

**Automatic checksums (new uploads):** As of late 2024, all new objects uploaded via AWS
SDKs, CLI, or console automatically get a CRC64NVME checksum computed server-side.
This is a full-object checksum even for multipart uploads (CRC64NVME supports
composability).

**Additional checksums at upload time:** You can request S3 compute any of these during
upload: SHA-256, SHA-1, CRC32C, CRC32, CRC64NVME. The checksum is stored as object
metadata and returned via `HeadObject` or `GetObjectAttributes`.

**Compute checksum on existing objects:** S3 Batch Operations can compute checksums on
billions of existing objects server-side without downloading them.
You submit a job specifying the algorithm (SHA-256, SHA-1, MD5, CRC32, CRC32C,
CRC64NVME) and S3 processes them asynchronously.

**Retrieving checksums:** `HeadObject` returns the checksum in
`x-amz-checksum-crc64nvme`, `x-amz-checksum-sha256`, etc.
headers. `GetObjectAttributes` returns checksums in the response body.

**Multipart upload behavior:**

- **Full-object checksum** (CRC64NVME, CRC32, CRC32C): S3 computes the checksum of the
  entire assembled object.
  The checksum matches what you’d get hashing the whole file locally.
  This is the best option for verification.
- **Composite checksum** (SHA-256, SHA-1, MD5): S3 computes per-part checksums and
  combines them. The composite checksum does NOT match a simple hash of the whole file.
  Format: `hash-of-concatenated-part-hashes-N` where N is the number of parts.

**Verification workflow (local vs remote):**

```
1. Upload file with x-amz-checksum-sha256 (or CRC32C, CRC64NVME)
2. Later: HEAD object -> get x-amz-checksum-sha256
3. Hash local file with SHA-256
4. Compare: if hashes match, files are identical
```

This works perfectly for single-part uploads.
For multipart uploads, use CRC64NVME or CRC32C (which support full-object checksums)
instead of SHA-256 (which produces a composite checksum).

### 5.3 Google Cloud Storage

**Automatic:** Every object gets CRC32C. Non-composite objects also get MD5.

**Retrieval:** Both hashes are available via object metadata (HEAD request).
`gcloud storage ls -L` shows them.
The `@google-cloud/storage` SDK exposes them via `file.metadata.crc32c` and
`file.metadata.md5Hash`.

**Verification workflow:**

```
1. Upload file (hashes computed automatically)
2. HEAD object -> get CRC32C (base64-encoded) and MD5 (base64-encoded)
3. Hash local file with CRC32C or MD5
4. Compare
```

**Limitation:** Composite objects (from parallel composite uploads or object
composition) only have CRC32C, not MD5. If blobsy ever uses parallel composite uploads
for GCS, it can only verify via CRC32C.

**Gotcha:** `gcloud storage rsync` uses these checksums for change detection when you
pass `--checksums-only`, making it more reliable than `aws s3 sync`’s size+mtime
approach.

### 5.4 Azure Blob Storage

**Automatic:** Only for simple `PutBlob` uploads -- Azure computes and stores MD5.

**Not automatic:** For block uploads (`PutBlock`/`PutBlockList`) -- the standard method
for files over ~256 MB -- Azure does **not** compute any hash.
The client must calculate MD5 locally and set it via `x-ms-blob-content-md5`. If the
client doesn’t set it, the blob has **no hash at all**.

**Verification workflow:**

```
1. Upload file via PutBlob (small files) -> MD5 computed automatically
   OR upload via PutBlock/PutBlockList (large files) -> must provide MD5
2. HEAD blob -> get Content-MD5 property (if set)
3. Hash local file with MD5
4. Compare
```

**This is the weakest checksum support of any major provider.** Large files uploaded
without explicit MD5 cannot be verified remotely.
If blobsy supports Azure Blob, it should always compute and set MD5 (or a custom
metadata hash) during upload.

### 5.5 Backblaze B2

**Automatic:** SHA-1 for each uploaded part, and for simple (non-large) file uploads.

**Large files:** Each part has SHA-1, but the assembled large file returns
`X-Bz-Content-Sha1: none`. Backblaze recommends setting `large_file_sha1` in file
metadata during `b2_start_large_file`, but this is optional and must be computed
client-side.

**Verification workflow:**

```
1. Upload small file -> SHA-1 computed automatically, returned in X-Bz-Content-Sha1
2. Upload large file -> set large_file_sha1 in metadata (optional)
3. HEAD object -> get SHA-1 (small files) or metadata (large files)
4. Hash local file with SHA-1
5. Compare
```

**Gotcha:** B2 uses SHA-1 (not SHA-256 or MD5). SHA-1 is cryptographically broken for
collision resistance but still fine for integrity verification.

### 5.6 Cloudflare R2

**Automatic:** MD5 for non-multipart uploads (exposed as ETag).

**Additional checksums:** R2 supports specifying SHA-256, SHA-1, SHA-384, SHA-512, or
CRC64NVME at upload time, but only one per upload.
If provided, it’s stored and retrievable.

**Multipart:** Composite ETag (not whole-file MD5). Same format as S3:
`md5-of-part-md5s-N`.

**Verification workflow:** Same as S3 for non-multipart.
For multipart, use the CRC64NVME full-object checksum if specified at upload time.

### 5.7 Comparison: Remote Verification Without Download

| Provider | Can verify without download? | Algorithm | Multipart files? | Effort |
| --- | --- | --- | --- | --- |
| **AWS S3** | Yes | CRC64NVME (auto), SHA-256/CRC32C (opt-in) | Yes (CRC64NVME is full-object) | Low -- automatic |
| **GCS** | Yes | CRC32C (auto), MD5 (non-composite) | CRC32C only | Low -- automatic |
| **Azure Blob** | Partial | MD5 (simple uploads only) | **No** (unless client provides hash) | High -- client must compute |
| **R2** | Yes (non-multipart) | MD5 (auto), SHA-256 (opt-in) | Only if checksum specified at upload | Medium |
| **B2** | Yes (small files) | SHA-1 | **No** (unless client provides hash) | Medium |
| **Wasabi** | Yes (non-multipart) | MD5 (ETag) | Composite only | Medium |
| **Tigris** | Yes (non-multipart) | MD5 (ETag) | Composite only | Medium |
| **DO Spaces** | Yes (non-multipart) | MD5 (ETag) | Composite only | Medium |

### 5.8 Implications for blobsy

**blobsy’s SHA-256 approach is validated.** The provider-native checksum landscape is
fragmented:

- Different providers use different algorithms (CRC64NVME, CRC32C, MD5, SHA-1)
- Multipart uploads break whole-file checksums on most providers
- Some providers (Azure, B2 for large files) may have no hash at all
- Composite checksums don’t match simple file hashes

blobsy’s design of computing SHA-256 independently and storing it in pointer
files/manifests is the **only portable approach** that works consistently across all
providers. It avoids all the provider-specific hash fragmentation.

**However, provider checksums are still useful for:**

1. **Transfer integrity on upload:** Providing a checksum with the upload request lets
   the server verify the transfer completed correctly.
   S3 can verify SHA-256, GCS can verify CRC32C/MD5, etc.
2. **Quick staleness check:** `HeadObject` returning a provider hash is cheaper than
   downloading the file to re-hash.
   If blobsy tracks the provider-side hash (e.g., ETag) in the manifest alongside
   SHA-256, it can do a quick remote check without download.
3. **S3 Batch Operations:** For large-scale verification, S3’s server-side compute
   checksum can verify billions of objects without any data transfer.

**Recommendation:** blobsy should:

- Always provide a checksum during upload (SHA-256 for S3, CRC32C for GCS) for transfer
  integrity
- Store SHA-256 in pointer files/manifests as the canonical hash (provider-independent)
- Optionally store the provider ETag in the manifest for cheap remote staleness checks
- Not rely on provider checksums for change detection (too fragmented, too many edge
  cases with multipart uploads)

## Part 6: blobsy Backend Integration Strategy

### 6.1 V1: S3-Compatible Providers via `type: s3`

All S3-compatible providers (S3, GCS, R2, B2, Wasabi, Tigris, DO Spaces) work with a
single `type: s3` backend, differentiated only by endpoint:

```yaml
backends:
  aws:
    type: s3
    bucket: my-data
    prefix: project/
    region: us-east-1

  gcs:
    type: s3
    endpoint: https://storage.googleapis.com
    bucket: my-gcs-data
    # Uses HMAC keys via AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY

  r2:
    type: s3
    endpoint: https://ACCOUNT_ID.r2.cloudflarestorage.com
    bucket: my-r2-data

  b2:
    type: s3
    endpoint: https://s3.us-west-004.backblazeb2.com
    bucket: my-b2-data
```

### 6.2 V1: Sync Tool Resolution

```yaml
sync:
  tool: auto   # auto | aws-cli | gcloud | azcopy | rclone | built-in
```

Auto resolution: `aws-cli` (if available and backend is S3-type) -> `rclone` (if
available) -> `built-in` (`@aws-sdk/client-s3`).

For GCS-native and Azure-native backends (future), auto resolution would prefer `gcloud`
or `azcopy` respectively.

### 6.3 Future: Native Backend Types

| Backend Type | When | Why |
| --- | --- | --- |
| `type: gcs` | When users need ADC auth or parallel composite uploads | Better DX than HMAC keys |
| `type: azure-blob` | When Azure users need native support | S3 compat not available |
| `type: command` | Already in design | Escape hatch for unsupported backends |
| `type: local` | Already in design | Development and testing |

### 6.4 Key Dependencies by Backend Type

| Backend | Built-in SDK | Sync CLI |
| --- | --- | --- |
| S3-compatible | `@aws-sdk/client-s3` | `aws s3 sync`, rclone |
| GCS (native) | `@google-cloud/storage` | `gcloud storage rsync`, rclone |
| Azure Blob | `@azure/storage-blob` | `azcopy sync`, rclone |

rclone is the universal fallback -- it supports all providers natively, making it the
lowest-effort path to multi-cloud support.

## Recommendations

1. **Client-side compression is the only portable approach.** No hosted provider offers
   transparent compression.
   The blobsy design correctly treats compression as a client concern.

2. **Consider `compression: none` as default.** Maximum simplicity, full sync delegation
   to transport tools, transparent remote storage.
   Make compression opt-in.

3. **Avoid `Content-Encoding: gzip` for storage.** GCS decompressive transcoding and
   R2’s similar behavior create too many edge cases.
   Blobsy should store `.zst` files as opaque blobs with
   `Content-Type: application/octet-stream`.

4. **SHA-256 in pointer files is the right choice for change detection.** ETags are
   unreliable across providers (MinIO compression changes them, GCS transcoding
   invalidates them, multipart uploads produce non-MD5 ETags).
   Blobsy’s independent SHA-256 hashing sidesteps all of this.

5. **`type: s3` covers most providers in V1.** GCS, R2, B2, Wasabi, Tigris, DO Spaces
   all work via S3-compatible endpoint.
   Only Azure Blob requires a dedicated backend type.

6. **rclone is the universal sync fallback.** It supports all providers natively and
   provides the easiest path to multi-cloud support.

7. **For cost-sensitive users:** B2 ($5/TB storage) + Cloudflare CDN (free egress via
   Bandwidth Alliance) or R2 ($15/TB, zero egress) are the most cost-effective options.

## References

### Provider Documentation

- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
- [GCS Interoperability (S3 compatibility)](https://cloud.google.com/storage/docs/interoperability)
- [GCS XML API Reference Methods](https://cloud.google.com/storage/docs/xml-api/reference-methods)
- [GCS Decompressive Transcoding](https://cloud.google.com/storage/docs/transcoding)
- [GCS Pricing](https://cloud.google.com/storage/pricing)
- [gcloud storage rsync Reference](https://cloud.google.com/sdk/gcloud/reference/storage/rsync)
- [Azure Blob Storage Overview](https://learn.microsoft.com/en-us/azure/storage/blobs/)
- [Azure Blob Access Tiers](https://learn.microsoft.com/en-us/azure/storage/blobs/access-tiers-overview)
- [azcopy sync Reference](https://learn.microsoft.com/en-us/azure/storage/common/storage-ref-azcopy-sync)
- [Azure Blob Pricing](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Backblaze B2 S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
- [Backblaze B2 Pricing](https://www.backblaze.com/cloud-storage/transaction-pricing)
- [Wasabi Pricing](https://wasabi.com/pricing)
- [Wasabi Minimum Storage Duration Policy](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work)
- [Tigris S3 API Compatibility](https://www.tigrisdata.com/docs/api/s3/)
- [Tigris Pricing](https://www.tigrisdata.com/pricing/)
- [DigitalOcean Spaces S3 Compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/)
- [DigitalOcean Spaces Pricing](https://docs.digitalocean.com/products/spaces/details/pricing/)

### Checksums and Integrity

- [AWS S3 Checking Object Integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)
- [AWS S3 Default Data Integrity Protections](https://aws.amazon.com/blogs/aws/introducing-default-data-integrity-protections-for-new-objects-in-amazon-s3/)
- [AWS S3 Compute Checksum (Batch Operations)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/batch-ops-compute-checksums.html)
- [AWS S3 Additional Checksum Algorithms](https://aws.amazon.com/blogs/aws/new-additional-checksum-algorithms-for-amazon-s3/)
- [GCS Data Validation and Change Detection](https://cloud.google.com/storage/docs/data-validation)
- [Azure Blob MD5 Overview](https://technet2.github.io/Wiki/blogs/windowsazurestorage/windows-azure-blob-md5-overview.html)
- [Backblaze B2 SHA-1 and Large Files](https://help.backblaze.com/hc/en-us/articles/225719728-Why-Are-My-Files-Missing-a-SHA-1)
- [R2 S3 API Compatibility (checksums)](https://developers.cloudflare.com/r2/api/s3/api/)

### Compression

- [MinIO Transparent Data Compression](https://blog.min.io/transparent-data-compression/)
- [MinIO Compression Documentation](https://min.io/docs/minio/linux/administration/object-management/data-compression.html)
- [Amazon Gzip to Zstd Switch (InfoQ)](https://www.infoq.com/news/2022/09/amazon-gzip-zstd/)
- [Facebook Zstandard](http://facebook.github.io/zstd/)
- [Cloudflare Transparent Decompression Analysis](https://kian.org.uk/cloudflares-transparent-decompression-how-does-it-work/)

### Sync Tools and SDKs

- [rclone S3 Providers](https://rclone.org/s3/)
- [rclone Google Cloud Storage](https://rclone.org/googlecloudstorage/)
- [rclone Azure Blob](https://rclone.org/azureblob/)
- [rclone R2 Compressed Files Issue (GitHub #8137)](https://github.com/rclone/rclone/issues/8137)
- [@aws-sdk/client-s3 (npm)](https://www.npmjs.com/package/@aws-sdk/client-s3)
- [@google-cloud/storage (npm)](https://www.npmjs.com/package/@google-cloud/storage)
- [@azure/storage-blob (npm)](https://www.npmjs.com/package/@azure/storage-blob)
- [aws s3 sync CLI Reference](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html)
- [S3 HTTP/1.1 vs GCS HTTP/2 Analysis (Onehouse)](https://www.onehouse.ai/blog/inflated-data-lakehouse-costs-and-latencies-blame-s3s-choice-of-http-1-1)
