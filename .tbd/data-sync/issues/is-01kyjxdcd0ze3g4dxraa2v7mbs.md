---
type: is
id: is-01kyjxdcd0ze3g4dxraa2v7mbs
title: "TEST batch: TEST-02 dead infra, TEST-06 error goldens, TEST-07 rm.test fragility, TEST-08 matrix/coverage-script drift"
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:58.656Z
updated_at: 2026-07-28T02:27:55.434Z
closed_at: 2026-07-28T02:27:55.434Z
close_reason: TEST-02 dead infra removed; TEST-06 cloud-errors golden added; TEST-07 verified already fixed by DS-04 rewrite; TEST-08 matrix regenerated, elisions fixed, coverage script in CI, testing-design paths corrected.
---
Delete tests/e2e refs + compile-template leftover; add auth/permission/network error goldens via echo backend; fix rm.test.ts prompt races + early returns (parts obsolete after DS-04); regenerate golden coverage matrix, fix ... elisions, wire check-golden-coverage.sh into CI.
