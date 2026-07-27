---
type: is
id: is-01kyjxcdvvphj5f8vve6vt3nw5
title: "TEST-05: run tests before publish in release.yml"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:27.387Z
updated_at: 2026-07-27T23:57:53.738Z
closed_at: 2026-07-27T23:57:53.738Z
close_reason: Landed in P1 gate batch commit; goldens no-hooks + config-defaults added; 286 unit tests green
---
release.yml publishes with no test step (publish.yml has one). Add pnpm test (and golden suite once wired) before publish, or consolidate workflows.
