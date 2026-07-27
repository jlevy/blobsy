---
type: is
id: is-01kyjxdbc2n8z7qnqjrx9esck2
title: "BE batch: BE-05 command pull ensureDir+cleanup, BE-06 relative_path, BE-07 HeadBucket health, BE-08 bucket-less {remote}, BE-09 atomicity/exists/which fixes"
kind: bug
status: open
priority: 2
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:57.602Z
updated_at: 2026-07-27T23:08:57.602Z
---
Per review doc findings BE-05..BE-09: ensureDir+try/finally-unlink in CommandBackend.pull; thread repo-relative path or remove {relative_path}; HeadBucket instead of put+delete probe; omit leading slash without bucket; atomic local push, coordinator-enforced pull atomicity, NoSuchBucket detection, platform-aware which on expanded argv0.
