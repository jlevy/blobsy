---
type: is
id: is-01kyjxcejq8mjzz9r25rgf3x50
title: "BE-04: streaming multipart S3 uploads (lib-storage) + streamed pulls"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:28.118Z
updated_at: 2026-07-27T23:57:53.727Z
closed_at: 2026-07-27T23:57:53.727Z
close_reason: Landed in P1 gate batch commit; goldens no-hooks + config-defaults added; 286 unit tests green
---
backend-s3.ts:66-91,117-120: @aws-sdk/lib-storage Upload for push (multipart, abort/cleanup, part concurrency); pipeline(response.Body, createWriteStream(tmp)) for pull. Tests: forced-multipart small threshold, interrupted-upload cleanup.
