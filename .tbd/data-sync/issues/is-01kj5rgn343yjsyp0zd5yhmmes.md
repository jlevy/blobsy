---
type: is
id: is-01kj5rgn343yjsyp0zd5yhmmes
title: "Phase 1: Implement blobsy setup command core"
kind: task
status: closed
priority: 2
version: 5
spec_path: docs/project/specs/active/plan-2026-02-23-blobsy-setup-and-agent-integration.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj5rgnq6hnrtdqpah59ga9ap
parent_id: is-01kj5rgah22ev1qxxag8v077mp
created_at: 2026-02-23T17:24:53.475Z
updated_at: 2026-02-23T18:19:55.071Z
closed_at: 2026-02-23T18:19:55.070Z
close_reason: Implemented blobsy setup --auto command that wraps init, validates --auto flag, shows next-steps guidance. Golden test and help output updated.
---
Implement blobsy setup command core

Tasks:
- Create packages/blobsy/src/cli/commands/setup.ts
  - Implement SetupAutoHandler class
  - Verify git repository
  - Parse backend URL (same logic as init)
  - Call blobsy init internally
  - Return success message with next steps
- Register setup command in packages/blobsy/src/cli/cli.ts
- Add to command list in help

Testing:
- Create tests/golden/commands/setup.tryscript.md
- Test error cases: not in git repo, invalid URL
- Test dry-run mode

Acceptance:
- blobsy setup --auto <url> works end-to-end
- Wraps blobsy init correctly
- Clear error messages for edge cases
