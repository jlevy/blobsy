---
type: is
id: is-01khzak4w3b1cpr95c75tj7ef6
title: Document rename/move interaction with stat cache
kind: task
status: closed
priority: 2
version: 2
labels: []
dependencies: []
created_at: 2026-02-21T05:26:08.514Z
updated_at: 2026-02-21T05:37:10.559Z
closed_at: 2026-02-21T05:37:10.558Z
close_reason: blobsy mv is already designed in V1 (main design lines 1111-1190). Conflict detection doc just needs a note referencing it.
---
**Source:** GPT 5 Pro review §4.5 (P0 gap in main design)

**Problem:** When a file is renamed:
- `git mv data/a.bin.yref data/b.bin.yref` moves the ref
- Gitignored payload `data/a.bin` is NOT moved
- Stat cache has entry for `data/a.bin` but not `data/b.bin`

**After rename:**
`blobsy sync` on `data/b.bin` finds no cache entry → hits no-cache path → potentially mishandles state

**GPT 5 Pro recommendation:**
Need `blobsy mv <old> <new>` that:
- Moves local payload
- Moves .yref
- Updates .gitignore entries
- Updates stat cache entry path
- Avoids re-upload if CAS

**For conflict detection doc:** At minimum, acknowledge this interaction in a note or FAQ entry.

**For main design:** This is a larger feature (GPT 5 Pro calls it P0 for the main design)

**Impact:** Medium - workarounds exist (manual file move + re-track), but it's a footgun

**File:** docs/project/design/current/conflict-detection-and-resolution.md
