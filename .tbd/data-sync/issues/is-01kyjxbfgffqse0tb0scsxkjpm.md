---
type: is
id: is-01kyjxbfgffqse0tb0scsxkjpm
title: "DX-01: Hermetic test harness — resolve CLI from checkout, print binary version, drop CI global-link"
kind: bug
status: closed
priority: 0
version: 4
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies:
  - type: blocks
    target: is-01kyjxbfvjj7be4455g3appn00
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:56.303Z
updated_at: 2026-07-27T23:16:27.054Z
closed_at: 2026-07-27T23:16:27.054Z
close_reason: "Hermetic harness landed in e303396: tests/helpers/cli.ts spawns dist/cli.mjs by absolute path, globalSetup prints binary+version, CI global-link step removed; 253/253 green with blobsy absent from PATH"
---
vitest helpers + golden runner must resolve packages/blobsy/dist/cli.mjs by absolute path instead of 'blobsy' from PATH; print tested binary path+version; remove ci.yml pnpm link --global step. Acceptance: fresh clone pnpm install && build && test green with no global link.
