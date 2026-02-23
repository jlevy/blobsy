---
type: is
id: is-01kj5rgky95znsy5e1kmy1p74n
title: "Phase 1: Consolidate blobsy skill command (remove prime)"
kind: task
status: open
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-23-blobsy-setup-and-agent-integration.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj5rgn343yjsyp0zd5yhmmes
parent_id: is-01kj5rgah22ev1qxxag8v077mp
created_at: 2026-02-23T17:24:52.295Z
updated_at: 2026-02-23T17:25:14.899Z
---
Consolidate blobsy skill command (remove prime)

Tasks:
- Update packages/blobsy/src/skill-text.ts
  - Make skill output context-efficient (~200-300 tokens)
  - Include: installation, when to use, quick reference
  - Point to status --json and doctor --json for state
  - Remove PRIME_TEXT constant and prime command handler
- Update packages/blobsy/src/cli/cli.ts
  - Remove prime command registration
  - Update help text to reference skill (not prime)
- Update tests/golden/commands/skill.tryscript.md with new output
- Remove any prime-related tests

Acceptance:
- blobsy skill outputs ~200-300 token brief orientation
- blobsy prime command no longer exists
- Golden tests pass
