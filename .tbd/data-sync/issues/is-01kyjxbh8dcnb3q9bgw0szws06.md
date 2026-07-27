---
type: is
id: is-01kyjxbh8dcnb3q9bgw0szws06
title: "DS-03: push hash sanity check — refuse modified-under-stale-hash uploads"
kind: bug
status: open
priority: 0
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:58.093Z
updated_at: 2026-07-27T23:07:58.093Z
---
handlePush/pushFile: hash local file first; mismatch vs ref.hash -> fail with three-option error (track / pull --force / push --force). Report modified-but-already-pushed instead of silent skip. Golden test.
