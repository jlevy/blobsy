---
type: is
id: is-01kj5rgq4v5b62w09bazv0spp9
title: "Phase 4: Update help text and error messages"
kind: task
status: open
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-23-blobsy-setup-and-agent-integration.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj5rgqx6n7b3mds1ahj0m7nd
parent_id: is-01kj5rgah22ev1qxxag8v077mp
created_at: 2026-02-23T17:24:55.577Z
updated_at: 2026-02-23T17:25:44.736Z
---
Update help text and error messages

CLI help:
- Add "Getting Started" epilog to main help
- Show blobsy setup --auto as recommended installation
- Update blobsy init help to note it is low-level

No-args behavior:
- Show help with prominent setup instructions
- Reference blobsy skill for agent orientation

Error messages:
- When not initialized, suggest blobsy setup --auto
- Clear messaging about setup vs init
- Consistent error format

Acceptance:
- Help text guides users to setup
- Error messages provide clear next steps
- Golden tests for help output pass
