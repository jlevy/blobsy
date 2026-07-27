---
type: is
id: is-01kyjxbgxh0nv52x2ca5v00edq
title: "DS-02: pull refuses locally modified files without --force (exit 2)"
kind: bug
status: open
priority: 0
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies:
  - type: blocks
    target: is-01kyjxcd320rmd4vxsydxyqymw
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:57.745Z
updated_at: 2026-07-27T23:09:12.122Z
---
commands-stage2.ts:335-345: without --force, local hash != ref hash -> refuse exit 2 with guidance; with --force overwrite. Fix inverted --force semantics. Golden test.
