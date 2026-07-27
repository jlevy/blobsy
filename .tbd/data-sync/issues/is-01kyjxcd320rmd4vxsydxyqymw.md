---
type: is
id: is-01kyjxcd320rmd4vxsydxyqymw
title: "CLI-02: truthful --dry-run for sync and pull"
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:26.593Z
updated_at: 2026-07-27T23:08:26.593Z
---
commands-stage2.ts:408-417 (sync dry-run omits modified->push case), :304-321 (pull dry-run counts up-to-date skips). Run real per-file decision logic in dry-run mode. Depends on DS-01/DS-02 decision logic.
