---
type: is
id: is-01kj4rxcpa005gf4t6ekvxjvfv
title: "Phase 7: Enhance blobsy config with --global, --show-origin, --unset"
kind: feature
status: closed
priority: 2
version: 7
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - polish
dependencies:
  - type: blocks
    target: is-01kj4rxngnmgzcahnmr8rd57r6
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
child_order_hints:
  - is-01kj4sj30hcrvr8zhj0f2pgw97
  - is-01kj4sj35f6px3h07hd4tqycrp
  - is-01kj4sj3a3g1k5dc200w8bjtr1
created_at: 2026-02-23T08:12:36.425Z
updated_at: 2026-02-24T17:31:29.875Z
closed_at: 2026-02-24T17:31:29.873Z
close_reason: "Phase 7 complete: config enhancements fully implemented"
---
Add --global flag (read/write ~/.blobsy.yml, works outside git repo). Add --show-origin (tab-separated scope + file + value, resolveConfigWithOrigins helper). Add --unset (unsetNestedValue helper, idempotent). Change blobsy config (no args) to show effective resolved config. Update config golden tests, add config-global.tryscript.md, config-show-origin.tryscript.md, config-global-no-repo.tryscript.md. Update README, SKILL.md, CHANGELOG, design doc.
