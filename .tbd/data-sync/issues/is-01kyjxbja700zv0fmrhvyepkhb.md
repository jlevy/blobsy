---
type: is
id: is-01kyjxbja700zv0fmrhvyepkhb
title: "BE-03: LocalBackend remote_key containment + shape validation"
kind: bug
status: open
priority: 0
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:59.175Z
updated_at: 2026-07-27T23:07:59.175Z
---
backend-local.ts:27,54,120,125: resolve(remoteDir,key) must start with resolve(remoteDir)+sep else reject. Validate remote_key shape at readBref for all backends. Unit + golden test with traversal key.
