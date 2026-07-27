---
type: is
id: is-01kyjxdc1cw9hz6k6qnkd1b1mz
title: "LIB-03: unknown template variables -> hard ValidationError"
kind: bug
status: open
priority: 2
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:58.284Z
updated_at: 2026-07-27T23:08:58.284Z
---
template.ts:75 warns to stderr regardless of --json/--quiet. Make unknown vars a ValidationError for alpha.
