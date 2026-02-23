---
type: is
id: is-01kj4rwfp5etf8n1js8k0t9rdp
title: "Phase 2: Add --min-size flag to track command"
kind: feature
status: open
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - polish
dependencies:
  - type: blocks
    target: is-01kj4jty4bpmc5xzdv0b2zh2z1
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
created_at: 2026-02-23T08:12:06.723Z
updated_at: 2026-02-23T08:13:02.013Z
---
Add .option('--min-size <size>') to track command. Pass through handleTrack -> trackDirectory to override config externalize.min_size. Add golden tests (track, externalization, track-json). Update README, SKILL.md, CHANGELOG.
