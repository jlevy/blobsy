---
type: is
id: is-01kj4sf9pr1wwfts059eqjx3aw
title: "Phase 3b: Implement handleAdd and register add command"
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj4sf9vamybyq29nbzvfg8zg
parent_id: is-01kj4jty4bpmc5xzdv0b2zh2z1
created_at: 2026-02-23T08:22:23.191Z
updated_at: 2026-02-24T17:31:26.458Z
closed_at: 2026-02-24T17:31:26.456Z
close_reason: "Phase 3b implemented: handleAdd and add command registered"
---
Register add command before track with same flags (--force, --min-size, --dry-run inherited). Import execFileSync from node:child_process. Implement handleAdd(): call trackSingleFile/trackDirectory, collect filesToStage, call git add, print staging summary and hint. Handle JSON, quiet, verbose output modes. Files: cli.ts (new command registration ~line 170, new handleAdd function).
