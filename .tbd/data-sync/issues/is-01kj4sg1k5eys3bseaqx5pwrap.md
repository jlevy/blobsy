---
type: is
id: is-01kj4sg1k5eys3bseaqx5pwrap
title: "Phase 4b: Create docs directory, doc files, and copy-docs build script"
kind: task
status: open
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj4sg1r11p3ncvxfzmxxh9ag
parent_id: is-01kj4rwr0tzt271zn7hwhy013m
created_at: 2026-02-23T08:22:47.652Z
updated_at: 2026-02-23T08:22:55.900Z
---
Create packages/blobsy/docs/ directory. Write blobsy-docs.md (~250 lines) with ## section headers: Conceptual Model, Configuration, Built-in Defaults, Externalization Rules, Compression, Ignore Patterns, Backend Configuration, CI Integration, Common Workflows. Write blobsy-docs-brief.md (~80 lines condensed version). Create packages/blobsy/scripts/copy-docs.mjs to copy docs/ and README.md to dist/docs/. Update package.json build script to 'tsdown && node scripts/copy-docs.mjs'.
