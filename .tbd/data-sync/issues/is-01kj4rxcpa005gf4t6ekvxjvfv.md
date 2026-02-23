---
type: is
id: is-01kj4rxcpa005gf4t6ekvxjvfv
title: "Phase 7: Enhance blobsy config with --global, --show-origin, --unset"
kind: feature
status: open
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - polish
dependencies:
  - type: blocks
    target: is-01kj4rxngnmgzcahnmr8rd57r6
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
created_at: 2026-02-23T08:12:36.425Z
updated_at: 2026-02-23T08:13:02.737Z
---
Add --global flag (read/write ~/.blobsy.yml, works outside git repo). Add --show-origin (tab-separated scope + file + value, resolveConfigWithOrigins helper). Add --unset (unsetNestedValue helper, idempotent). Change blobsy config (no args) to show effective resolved config. Update config golden tests, add config-global.tryscript.md, config-show-origin.tryscript.md, config-global-no-repo.tryscript.md. Update README, SKILL.md, CHANGELOG, design doc.
