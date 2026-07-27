---
type: is
id: is-01kyjxcddv1dbmbbhz7mseeky0
title: "TEST-03: fix S3 false-pass tests; add push/pull + aws-cli coverage"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:26.939Z
updated_at: 2026-07-27T23:57:53.735Z
closed_at: 2026-07-27T23:57:53.735Z
close_reason: Landed in P1 gate batch commit; goldens no-hooks + config-defaults added; 286 unit tests green
---
backend-s3.test.ts:87-98,101-111: use await expect(...).rejects.toThrow. Add S3 push/pull tests and backend-aws-cli tests (no test file exists).
