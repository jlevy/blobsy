---
type: is
id: is-01kj4rwr0tzt271zn7hwhy013m
title: "Phase 4: Add blobsy readme and blobsy docs commands"
kind: feature
status: closed
priority: 2
version: 7
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - docs
dependencies:
  - type: blocks
    target: is-01kj4rwybd4b1kgp3ksq8rv9qp
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
child_order_hints:
  - is-01kj4sg1ebt11maf8pqw9ncejd
  - is-01kj4sg1k5eys3bseaqx5pwrap
  - is-01kj4sg1r11p3ncvxfzmxxh9ag
created_at: 2026-02-23T08:12:15.256Z
updated_at: 2026-02-24T17:31:27.336Z
closed_at: 2026-02-24T17:31:27.333Z
close_reason: "Phase 4 complete: readme and docs commands fully implemented"
---
Add marked + marked-terminal deps. Create markdown-output.ts (renderMarkdown, paginateOutput, extractSections, findSection). Create docs/ directory with blobsy-docs.md and blobsy-docs-brief.md. Add copy-docs.mjs build script. Register readme command (loadBundledDoc + render + paginate). Register docs command with [topic], --list, --brief. Add unit tests (markdown-output.test.ts) and golden tests (readme.tryscript.md, docs.tryscript.md). Update help, README, SKILL.md, CHANGELOG, design doc.
