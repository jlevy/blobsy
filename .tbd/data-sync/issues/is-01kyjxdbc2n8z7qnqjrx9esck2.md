---
type: is
id: is-01kyjxdbc2n8z7qnqjrx9esck2
title: "BE batch: BE-05 command pull ensureDir+cleanup, BE-06 relative_path, BE-07 HeadBucket health, BE-08 bucket-less {remote}, BE-09 atomicity/exists/which fixes"
kind: bug
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:57.602Z
updated_at: 2026-07-28T02:15:32.965Z
closed_at: 2026-07-28T02:15:32.964Z
close_reason: "BE-05/08 done earlier; 5ad8c83 adds BE-06 (relative_path threaded through Backend interface), BE-07 (HeadBucket-only S3 health), BE-09 (atomic local push, S3 exists NoSuchBucket/404, expanded-argv0 + platform-aware which). Coordinator-level pull atomicity: every backend already implements temp+verify+rename internally."
---
Per review doc findings BE-05..BE-09: ensureDir+try/finally-unlink in CommandBackend.pull; thread repo-relative path or remove {relative_path}; HeadBucket instead of put+delete probe; omit leading slash without bucket; atomic local push, coordinator-enforced pull atomicity, NoSuchBucket detection, platform-aware which on expanded argv0.
