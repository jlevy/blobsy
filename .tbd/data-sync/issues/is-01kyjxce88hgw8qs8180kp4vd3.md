---
type: is
id: is-01kyjxce88hgw8qs8180kp4vd3
title: "BE-01: remove 60s transfer timeout (keep probe timeouts)"
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:27.784Z
updated_at: 2026-07-27T23:08:27.784Z
---
backend-aws-cli.ts:129, backend-rclone.ts:153, backend-command.ts:23,276: no timeout for transfers or size-aware/configurable; keep short timeouts for --version probes and exists checks.
