---
type: is
id: is-01kj4sj30hcrvr8zhj0f2pgw97
title: "Phase 7a: Add --global flag to blobsy config"
kind: task
status: closed
priority: 2
version: 4
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj4sj35f6px3h07hd4tqycrp
  - type: blocks
    target: is-01kj4sj3a3g1k5dc200w8bjtr1
parent_id: is-01kj4rxcpa005gf4t6ekvxjvfv
created_at: 2026-02-23T08:23:54.639Z
updated_at: 2026-02-24T17:31:29.448Z
closed_at: 2026-02-24T17:31:29.445Z
close_reason: "Phase 7a implemented: --global flag on config"
---
Add --global option to config command registration (cli.ts:238-242). Implement getTargetConfigPath() helper: returns ~/.blobsy.yml when --global, else getConfigPath(repoRoot). For reads: load only ~/.blobsy.yml (not resolved). For writes: write to ~/.blobsy.yml, create if missing. Skip findRepoRoot() when --global set: const repoRoot = opts.global ? null : findRepoRoot(). Change blobsy config (no args) to show effective resolved config as YAML (not raw file). Golden tests: config.tryscript.md updates, config-global.tryscript.md (new), config-global-no-repo.tryscript.md (new).
