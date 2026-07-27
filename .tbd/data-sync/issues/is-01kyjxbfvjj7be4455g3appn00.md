---
type: is
id: is-01kyjxbfvjj7be4455g3appn00
title: "TEST-01: Wire full golden suite into CI; re-record six stale gzip-era goldens"
kind: bug
status: closed
priority: 0
version: 3
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:56.658Z
updated_at: 2026-07-27T23:18:49.590Z
closed_at: 2026-07-27T23:18:49.590Z
close_reason: Golden suite in CI both lanes via hermetic run-golden.sh; six stale goldens re-recorded (32B/gzip -> 21B/zstd); wildcards preserved
---
Add test:golden script (full tryscript suite); wire into ci.yml both Node lanes (non-root; do NOT add to lefthook pre-push — root envs cannot fail permission scenarios). Re-record check-unpushed, push-pull, status, push-pull-json (gzip->zstd, 32->21), branch-workflow, fresh-setup after confirming zstd default is intended.
