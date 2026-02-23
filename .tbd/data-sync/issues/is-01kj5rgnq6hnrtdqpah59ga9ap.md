---
type: is
id: is-01kj5rgnq6hnrtdqpah59ga9ap
title: "Phase 2: Implement agent file installation (Claude + AGENTS.md)"
kind: task
status: closed
priority: 2
version: 6
spec_path: docs/project/specs/active/plan-2026-02-23-blobsy-setup-and-agent-integration.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj5rgpem0dq344ff80rc80m8
  - type: blocks
    target: is-01kj5rgq4v5b62w09bazv0spp9
parent_id: is-01kj5rgah22ev1qxxag8v077mp
created_at: 2026-02-23T17:24:54.116Z
updated_at: 2026-02-23T18:26:20.643Z
closed_at: 2026-02-23T18:26:20.641Z
close_reason: "Implemented agent file installation: .claude/skills/blobsy/SKILL.md and AGENTS.md section with markers. Both idempotent. 7 integration tests, golden test with full setup flow."
---
Implement agent file installation

Tasks:
- setupClaudeIfDetected() in setup.ts
  - Detect ~/.claude/ or CLAUDE_* env vars
  - Install .claude/skills/blobsy/SKILL.md (from blobsy skill output)
  - Skip if already exists (idempotent)
- setupAgentsMdIfDetected() in setup.ts
  - Detect existing AGENTS.md or CODEX_* env vars
  - Add/update blobsy section with markers
  - BEGIN BLOBSY INTEGRATION / END BLOBSY INTEGRATION
- Update packages/blobsy/SKILL.md template
  - Add installation instructions
  - Add "If not installed" section
  - Update "When to Use" triggers
- Update root AGENTS.md
  - Add blobsy integration section with markers

Testing:
- Verify .claude/skills/blobsy/SKILL.md content
- Verify AGENTS.md markers and content
- Test idempotency (re-running setup)

Acceptance:
- Agent files installed correctly
- Idempotent setup (safe to re-run)
- Skill files have correct content
