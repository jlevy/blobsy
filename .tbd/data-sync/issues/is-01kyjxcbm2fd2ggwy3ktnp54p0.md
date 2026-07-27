---
type: is
id: is-01kyjxcbm2fd2ggwy3ktnp54p0
title: "SEC-02: central resolveRepoPath() — contain user paths to repo root"
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:25.090Z
updated_at: 2026-07-27T23:08:25.090Z
---
paths.ts resolveFilePath is bare resolve(); add containment (resolved path within repoRoot, sep-suffix compare per CFG-01), realpath symlink policy for existing sources; use in every path-taking command (track/add/untrack/rm/mv/push/pull/status). Tests: absolute, ../, symlink-out, linked worktree.
