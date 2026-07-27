---
type: is
id: is-01kyjxbg6qzjsn8nmsk6v84rr0
title: "TEST-04: stat-cache unit tests (16 designed cases) — prerequisite for DS-01"
kind: task
status: closed
priority: 0
version: 4
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies:
  - type: blocks
    target: is-01kyjxbgjc5jdypy5afemzjen9
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:57.015Z
updated_at: 2026-07-27T23:20:28.124Z
closed_at: 2026-07-27T23:20:28.123Z
close_reason: 19 stat-cache tests landed; 3 designed cases await unimplemented functions (listCacheEntries, mtimeMs fallback, GC) — noted in TEST batch bead
---
Implement tests/stat-cache.test.ts covering the 16 cases at blobsy-testing-design.md:1957-1976. Must land before DS-01.
