---
type: is
id: is-01kj4sgw4xy9ma0h0km1r4fys7
title: "Phase 6a: Implement pre-commit hash verification hook"
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj4sgwj68dbpks5brnkmnbth
parent_id: is-01kj4rx5zmnz9bk0xha8re1bg4
created_at: 2026-02-23T08:23:14.843Z
updated_at: 2026-02-24T17:31:28.791Z
closed_at: 2026-02-24T17:31:28.789Z
close_reason: "Phase 6a implemented: pre-commit hash verification"
---
Replace no-op handleHook('pre-commit') at commands-stage2.ts:729-738 with handlePreCommitHook(). Logic: git diff --cached --name-only to find staged .bref files, readBref() each, computeHash() on data file, compare. Skip if data file missing (gitignored). Report mismatches with actionable error. Respect BLOBSY_NO_HOOKS env var. Golden test: pre-commit-hook.tryscript.md (mismatch rejected, clean passes, --no-verify bypasses).
