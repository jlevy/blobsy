---
type: is
id: is-01kj4sg1ebt11maf8pqw9ncejd
title: "Phase 4a: Add marked/marked-terminal deps and create markdown-output.ts"
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
created_at: 2026-02-23T08:22:47.497Z
updated_at: 2026-02-23T08:22:55.770Z
---
Install marked ^15.0.0 and marked-terminal ^7.3.0. Create packages/blobsy/src/markdown-output.ts with: isInteractive(), renderMarkdown(), paginateOutput(), extractSections(), findSection(), DocSection interface. Cast markedTerminal to work around type mismatch. Add unit tests: packages/blobsy/tests/markdown-output.test.ts.
