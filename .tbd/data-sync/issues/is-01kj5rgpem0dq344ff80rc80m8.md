---
type: is
id: is-01kj5rgpem0dq344ff80rc80m8
title: "Phase 3: Update all documentation (README, design, developer)"
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-23-blobsy-setup-and-agent-integration.md
labels: []
dependencies: []
parent_id: is-01kj5rgah22ev1qxxag8v077mp
created_at: 2026-02-23T17:24:54.867Z
updated_at: 2026-02-23T18:38:51.349Z
closed_at: 2026-02-23T18:38:51.348Z
close_reason: done
---
Update all documentation

User-facing docs:
- README.md
  - Change quick start to use blobsy setup --auto
  - Update command reference table (add setup, remove prime)
  - Add "Agent Integration" section

Design docs:
- docs/project/design/current/blobsy-design.md
  - Add setup command section
  - Update "Self-documenting" principle with setup flow
  - Document agent integration files
  - Add note about simplified approach vs tbd

Developer docs:
- CLAUDE.md (AGENTS.md)
  - Update development guide
  - Add blobsy setup workflow
  - Document agent integration architecture

Acceptance:
- All docs reflect new setup pattern
- No references to removed prime command
- Clear agent integration documentation
