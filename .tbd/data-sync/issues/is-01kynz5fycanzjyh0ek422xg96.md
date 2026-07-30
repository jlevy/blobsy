---
type: is
id: is-01kynz5fycanzjyh0ek422xg96
title: Decide and implement subdirectory .blobsy.yml semantics (or drop them)
kind: task
status: open
priority: 3
version: 1
labels:
  - design
  - config
dependencies: []
created_at: 2026-07-29T03:37:20.587Z
updated_at: 2026-07-29T03:37:20.587Z
---
Review round 7 (Top Issue 5, CFG-02) recommended deferring subdirectory configs for alpha: replace-not-merge semantics are a documented footgun, getExternalizeConfig falls back to builtin defaults instead of parent values, and they interact badly with mv re-evaluation and compression consistency. Current implementation: resolveConfig(targetPath, repoRoot) supports walking repo root -> target, but every call site passes (repoRoot, repoRoot), so nested .blobsy.yml files are wholly inert — track/add externalize rules, push/pull/sync, and config --show-origin all ignore them (Bugbot round 11, Medium, PR #4 e4a2a06). blobsy-design.md's 'Subdirectory Config Behavior' section describes intended post-alpha semantics and now carries an alpha-status note saying they are ignored.

Decision needed: (a) implement one-level-deep merge for externalize/compress/remote/sync and wire per-directory resolution into the scan paths, or (b) drop subdirectory configs permanently and delete the walk. Owner: jlevy.
