---
type: is
id: is-01kj5rgqx6n7b3mds1ahj0m7nd
title: "Phase 5: Add comprehensive tests (golden, integration, edge cases)"
kind: task
status: open
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-02-23-blobsy-setup-and-agent-integration.md
labels: []
dependencies: []
parent_id: is-01kj5rgah22ev1qxxag8v077mp
created_at: 2026-02-23T17:24:56.356Z
updated_at: 2026-02-23T17:25:46.557Z
---
Add comprehensive tests

Golden tests:
- setup.tryscript.md - Setup command variations
- setup-help.tryscript.md - Help output
- Update help.tryscript.md with new Getting Started section
- skill.tryscript.md already updated in Phase 1

Integration tests:
- Fresh repo setup flow
- Re-running setup (idempotent)
- Setup with different backend types (s3, local)

Edge cases:
- Setup in non-git directory
- Setup when already initialized
- Invalid backend URLs
- Missing dependencies

Acceptance:
- All golden tests pass
- Integration tests cover main flows
- Edge cases handled gracefully
- Test coverage maintained
