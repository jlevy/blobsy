---
type: is
id: is-01kyjxcb8vaana3n3k0fw3s1tb
title: "CLI-01: honor --no-hooks (opts.hooks !== false); golden asserting no hook files"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:24.731Z
updated_at: 2026-07-27T23:57:53.697Z
closed_at: 2026-07-27T23:57:53.696Z
close_reason: Landed in P1 gate batch commit; goldens no-hooks + config-defaults added; 286 unit tests green
---
cli.ts:137,146,671: commander maps --no-hooks to opts.hooks===false but code checks !opts.noHooks. Fix both setup --auto and init paths; add golden test.
