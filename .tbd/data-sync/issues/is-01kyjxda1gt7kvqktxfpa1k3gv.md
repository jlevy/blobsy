---
type: is
id: is-01kyjxda1gt7kvqktxfpa1k3gv
title: "HK-04 + HK-02: worktree-safe hook paths (git rev-parse --git-path hooks) + consolidate installers"
kind: bug
status: open
priority: 2
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:56.239Z
updated_at: 2026-07-27T23:08:56.239Z
---
cli.ts:684, commands-stage2.ts:1350,1370,1495 hardcode .git/hooks (ENOTDIR in linked worktrees; core.hooksPath ignored). One shared hooks module, one shim strategy; linked-worktree integration test. Builds on HK-03 ownership work.
