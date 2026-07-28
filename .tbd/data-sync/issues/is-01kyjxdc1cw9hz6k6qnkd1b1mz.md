---
type: is
id: is-01kyjxdc1cw9hz6k6qnkd1b1mz
title: "LIB-03: unknown template variables -> hard ValidationError"
kind: bug
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:58.284Z
updated_at: 2026-07-28T00:35:14.445Z
closed_at: 2026-07-28T00:35:14.445Z
close_reason: Landed in P2 hardening commit
---
template.ts:75 warns to stderr regardless of --json/--quiet. Make unknown vars a ValidationError for alpha.
