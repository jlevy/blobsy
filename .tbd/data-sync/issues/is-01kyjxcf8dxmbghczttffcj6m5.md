---
type: is
id: is-01kyjxcf8dxmbghczttffcj6m5
title: "DOCS-01: single-source the agent skill text; lead with add; frontmatter"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:28.812Z
updated_at: 2026-07-28T00:22:44.353Z
closed_at: 2026-07-28T00:22:44.353Z
close_reason: Backend reuse + sync.parallel removed; SKILL.md single-sourced with build-time generation
---
skill-text.ts must embed SKILL.md at build time (copy-docs step exists); lead with blobsy add; add name/description frontmatter; ship in npm package.
