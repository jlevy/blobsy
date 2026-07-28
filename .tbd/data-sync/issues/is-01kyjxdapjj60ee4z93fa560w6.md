---
type: is
id: is-01kyjxdapjj60ee4z93fa560w6
title: "CFG batch: CFG-01 startsWith+sep, CFG-02 subdir merge/defer, CFG-03 Zod schemas + conflict-marker preflight"
kind: bug
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:56.914Z
updated_at: 2026-07-28T01:38:42.543Z
closed_at: 2026-07-28T01:38:42.543Z
close_reason: CFG-01 (startsWith+sep, earlier), CFG-02 (one-level-deep section merge in mergeConfigs), CFG-03 (Zod schemas for .blobsy.yml and .bref + merge-conflict-marker preflight) all implemented in 3878374 with unit tests.
---
config.ts:142,198 sep-suffix compare; subdir override fallback to parent not builtin (or drop subdir configs for alpha); Zod validation for .blobsy.yml and .bref; merge-conflict-marker check with clear error.
