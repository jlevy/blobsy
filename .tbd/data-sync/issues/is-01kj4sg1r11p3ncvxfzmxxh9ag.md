---
type: is
id: is-01kj4sg1r11p3ncvxfzmxxh9ag
title: "Phase 4c: Register readme and docs commands in CLI"
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies: []
parent_id: is-01kj4rwr0tzt271zn7hwhy013m
created_at: 2026-02-23T08:22:47.808Z
updated_at: 2026-02-24T17:31:27.203Z
closed_at: 2026-02-24T17:31:27.200Z
close_reason: "Phase 4c implemented: readme and docs commands registered"
---
Add loadBundledDoc() helper in cli.ts using fileURLToPath(import.meta.url) with dev fallback paths. Register readme command: load README.md, render, paginate. Register docs command with [topic] arg, --list, --brief flags: load blobsy-docs.md, extract sections, filter by topic or list. Add golden tests: readme.tryscript.md, docs.tryscript.md. Update help.tryscript.md. Docs: README, SKILL.md, CHANGELOG, design doc.
