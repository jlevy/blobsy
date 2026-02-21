---
type: is
id: is-01khz6m7yw0eexvc028m2aa23d
title: "V2: Document trash/GC optimization pattern"
kind: task
status: open
priority: 3
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01khz60h5643s942z2ptd6x3sq
created_at: 2026-02-21T04:16:50.139Z
updated_at: 2026-02-21T04:16:55.429Z
---
Note in V2 section that using .blobsy/trash/ as a paper trail is a clever way to bound the search space for 'blobsy gc' without needing to walk the entire Git reflog to find orphaned blobs. This is a potential enhancement for the GC implementation.
