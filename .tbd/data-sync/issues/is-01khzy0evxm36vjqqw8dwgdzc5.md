---
type: is
id: is-01khzy0evxm36vjqqw8dwgdzc5
title: "Stage 2.2: Core template + compress (template.ts: evaluate key templates with {iso_date_secs}, {content_sha256}, {content_sha256_short}, {repo_path}, {filename}, {dirname}, {compress_suffix}; compress.ts: shouldCompress, compressFile/decompressFile streaming via node:zlib for zstd/gzip/brotli; unit test: template.test.ts)"
kind: task
status: closed
priority: 1
version: 4
spec_path: docs/project/specs/active/plan-2026-02-21-blobsy-v1-implementation.md
labels: []
dependencies:
  - type: blocks
    target: is-01khzy0f57m2wknzymw65xf7hc
parent_id: is-01khzqg0ff2jarf76zxgjpmq6p
created_at: 2026-02-21T11:05:27.675Z
updated_at: 2026-02-21T11:37:20.809Z
closed_at: 2026-02-21T11:37:20.808Z
close_reason: Implemented template evaluation with all variables and compress.ts with gzip/brotli streaming. Unit tests passing (13 template, 10 compress tests).
---
