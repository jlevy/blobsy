---
type: is
id: is-01kyt0r9tnha3mwzcy0tqrb9fj
title: "Decide run-sync direction: mirror mode (attach points + receipts) per round 8 review"
kind: task
status: open
priority: 1
version: 2
labels: []
dependencies: []
created_at: 2026-07-30T17:22:03.218Z
updated_at: 2026-07-30T17:22:10.943Z
---
Round 8 review doc: docs/project/design/current/blobsy-design-review-round8-run-sync-workflows.md. Decision for jlevy: approve/deny the file-vs-mirror mode split (attach points + receipts, non-goals 1-5 in sec 5). If approved: blobsy-4vpk resolves as 'drop nested configs', blobsy-aad8 is superseded (Option A tree-pointer mode should not be built), blobsy-pqyt stays file-mode-only. Follow-up grounding: read finterm-ai/trading docs/run-storage.md + scripts/sync_runs.py from a session with that repo attached (this review inspected the live GCS buckets only).
