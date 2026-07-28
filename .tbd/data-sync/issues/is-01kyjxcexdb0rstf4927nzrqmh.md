---
type: is
id: is-01kyjxcexdb0rstf4927nzrqmh
title: "BE-02: async exec + backend reuse; honor or delete sync.parallel"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:28.460Z
updated_at: 2026-07-28T00:22:44.337Z
closed_at: 2026-07-28T00:22:44.336Z
close_reason: Backend reuse + sync.parallel removed; SKILL.md single-sourced with build-time generation
---
Switch backends to async execFile/spawn; create backend once per command (currently per-file re-detection O(N) spawns); promise pool honoring sync.parallel, or delete the config key and document sequential.
