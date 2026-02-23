---
type: is
id: is-01kj4rx5zmnz9bk0xha8re1bg4
title: "Phase 6: Implement git hooks (pre-commit validation + pre-push auto-push)"
kind: feature
status: open
priority: 2
version: 6
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - polish
dependencies:
  - type: blocks
    target: is-01kj4rxngnmgzcahnmr8rd57r6
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
child_order_hints:
  - is-01kj4sgw4xy9ma0h0km1r4fys7
  - is-01kj4sgwdjc5nk861r76t5qst4
  - is-01kj4sgwj68dbpks5brnkmnbth
created_at: 2026-02-23T08:12:29.554Z
updated_at: 2026-02-23T08:23:15.268Z
---
Replace pre-commit no-op with hash verification (staged .bref files vs actual file hash). Add pre-push hook that runs blobsy push for unpushed blobs. Update installStubHook -> installHooks to install both. Add --no-hooks to init. Expand blobsy hooks to manage both. Update hooks.test.ts, hooks golden tests, init golden tests. Add pre-commit-hook.tryscript.md, pre-push-hook.tryscript.md. Update README (Git Hooks section), SKILL.md, CHANGELOG, design doc.
