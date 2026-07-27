---
type: is
id: is-01kyjxbhk70c9my602mnrn9nxw
title: "HK-01: pre-push hook fails on upload errors so git aborts push"
kind: bug
status: open
priority: 0
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:58.439Z
updated_at: 2026-07-27T23:07:58.439Z
---
commands-stage2.ts:1648-1685: collect failures, print each with error, set process.exitCode=1 on any failure. Golden: failed upload -> nonzero exit.
