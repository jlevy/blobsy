---
type: is
id: is-01kyjxbhyh36zk8mbt7vnchcn9
title: "DS-04: remove/hide rm --remote for alpha (reachability, not confirmation)"
kind: bug
status: open
priority: 0
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies:
  - type: blocks
    target: is-01kyjxdcd0ze3g4dxraa2v7mbs
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:58.800Z
updated_at: 2026-07-27T23:09:12.723Z
---
Remove readline prompt entirely; remote deletion off the alpha surface or --force-only emergency plumbing labeled history-breaking; never branch safety on --quiet. Update rm goldens + rm.test.ts (TEST-07 blocks obsolete). Defer reclamation to reachability-aware GC design.
