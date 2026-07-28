---
type: is
id: is-01kyjxccd0jfekkep33cq37qfe
title: "SEC-03: command-backend trust gate + threat model doc"
kind: feature
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:25.888Z
updated_at: 2026-07-28T00:10:16.664Z
closed_at: 2026-07-28T00:10:16.664Z
close_reason: Trust gate in createBackend + threat model doc + goldens
---
Repo .blobsy.yml selects arbitrary executables (backend-command.ts:120-205). Require user-global authorization (user-level config allowlist or explicit trust step) before executing command backends; never auto-execute from hooks without grant. Write threat model (who controls .blobsy.yml/.bref/credentials/hooks/paths) into design docs. Tests for the trust decision.
