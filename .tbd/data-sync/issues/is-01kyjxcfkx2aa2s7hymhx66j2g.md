---
type: is
id: is-01kyjxcfkx2aa2s7hymhx66j2g
title: "DOCS-02: README externalize default 1MB -> 200KB (4 places) + default-config golden"
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:29.181Z
updated_at: 2026-07-27T23:08:29.181Z
---
README.md:22,51,224-231 vs config.ts:26 (200kb since d28a935). Add golden printing default config to catch future drift.
