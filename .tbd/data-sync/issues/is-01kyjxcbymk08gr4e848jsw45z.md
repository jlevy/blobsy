---
type: is
id: is-01kyjxcbymk08gr4e848jsw45z
title: "HK-03: hook ownership — managed markers; never substring overwrite/delete"
kind: bug
status: open
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies:
  - type: blocks
    target: is-01kyjxda1gt7kvqktxfpa1k3gv
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:25.427Z
updated_at: 2026-07-27T23:09:12.420Z
---
hooks install writes unconditionally (commands-stage2.ts:1349-1361,1472-1488); uninstall deletes on substring (1493-1503); init path overwrites mixed hooks (cli.ts:702-716). Exact managed-marker ownership; refuse/compose for user hooks; backup before replace; mixed-hook tests.
