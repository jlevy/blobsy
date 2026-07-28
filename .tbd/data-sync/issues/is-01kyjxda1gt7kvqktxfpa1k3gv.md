---
type: is
id: is-01kyjxda1gt7kvqktxfpa1k3gv
title: "HK-04 + HK-02: worktree-safe hook paths (git rev-parse --git-path hooks) + consolidate installers"
kind: bug
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:56.239Z
updated_at: 2026-07-28T00:56:07.079Z
closed_at: 2026-07-28T00:56:07.079Z
close_reason: "Implemented in 970a074: shared src/hooks.ts installer (HK-02), git rev-parse --git-path hooks for worktrees/core.hooksPath (HK-04), BLOBSY_NO_HOOKS honored in hooks install and doctor --fix; tests added."
---
cli.ts:684, commands-stage2.ts:1350,1370,1495 hardcode .git/hooks (ENOTDIR in linked worktrees; core.hooksPath ignored). One shared hooks module, one shim strategy; linked-worktree integration test. Builds on HK-03 ownership work.
