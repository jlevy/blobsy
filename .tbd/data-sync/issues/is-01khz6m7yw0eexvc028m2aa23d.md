---
type: is
id: is-01khz6m7yw0eexvc028m2aa23d
title: "V2: Document trash/GC optimization pattern"
kind: task
status: closed
priority: 3
version: 4
labels: []
dependencies:
  - type: blocks
    target: is-01khz60h5643s942z2ptd6x3sq
created_at: 2026-02-21T04:16:50.139Z
updated_at: 2026-02-21T20:52:45.366Z
closed_at: 2026-02-21T20:52:45.365Z
close_reason: "Already documented in blobsy-design.md. Lines 2108-2124 cover the trash/GC optimization pattern in detail: (1) GC paper trail - .blobsy/trash/ bounds the search space for gc without walking entire git history, (2) Undo safety net, (3) GC cleanup of trash entries. The V2 deferred features section (lines 2621-2660) also documents gc --depth/--age semantics and template-agnostic GC behavior."
---
Note in V2 section that using .blobsy/trash/ as a paper trail is a clever way to bound the search space for 'blobsy gc' without needing to walk the entire Git reflog to find orphaned blobs. This is a potential enhancement for the GC implementation.
