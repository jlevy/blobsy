---
type: is
id: is-01kj4sgwdjc5nk861r76t5qst4
title: "Phase 6b: Implement pre-push auto-push hook"
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
created_at: 2026-02-23T08:23:15.120Z
updated_at: 2026-02-24T17:31:28.954Z
closed_at: 2026-02-24T17:31:28.951Z
close_reason: "Phase 6b implemented: pre-push auto-push"
---
Extract pushSingleFile() from handlePush() loop in commands-stage2.ts:130-150 (uses pushFile() from transfer.ts, updates .bref with remote_key). Add handlePrePushHook(): find all .bref files, filter for missing remote_key, call pushSingleFile for each. Golden test: pre-push-hook.tryscript.md (auto-push on git push, silent when all pushed, BLOBSY_NO_HOOKS bypass).
