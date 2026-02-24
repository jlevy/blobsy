---
type: is
id: is-01kj4sgwj68dbpks5brnkmnbth
title: "Phase 6c: Update hook installation for both hooks + --no-hooks"
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies: []
parent_id: is-01kj4rx5zmnz9bk0xha8re1bg4
created_at: 2026-02-23T08:23:15.268Z
updated_at: 2026-02-24T17:31:29.105Z
closed_at: 2026-02-24T17:31:29.103Z
close_reason: "Phase 6c implemented: both hooks installed, --no-hooks supported"
---
Rename installStubHook() to installHooks() at cli.ts:461-501. Install both pre-commit and pre-push hooks. Update HOOKS constant with both entries. Add --no-hooks option to init command (cli.ts:163-167). Update hidden hook command to accept pre-push (cli.ts:274-277). Update hooks command description (cli.ts:258-261). Update handleHooks() in commands-stage2.ts:562-643 to manage both hooks. Update hooks.test.ts and hooks.tryscript.md, init.tryscript.md, help.tryscript.md. Docs: README (Git Hooks section), SKILL.md, CHANGELOG, design doc.
