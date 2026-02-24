---
type: is
id: is-01kj4sf9j0w0k3559jcqzzwjak
title: "Phase 3a: Refactor trackSingleFile/trackDirectory to return TrackResult"
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies:
  - type: blocks
    target: is-01kj4sf9pr1wwfts059eqjx3aw
parent_id: is-01kj4jty4bpmc5xzdv0b2zh2z1
created_at: 2026-02-23T08:22:23.038Z
updated_at: 2026-02-24T17:31:26.299Z
closed_at: 2026-02-24T17:31:26.298Z
close_reason: "Phase 3a implemented: TrackResult type, track functions return it"
---
Define TrackResult interface (filesToStage, externalized, unchanged, keptInGit). Modify trackSingleFile() to collect .bref and .gitignore paths in filesToStage after writeBref/addGitignoreEntry calls. Modify trackDirectory() to collect both externalized file paths (.bref, .gitignore) and non-externalized file paths. Deduplicate .gitignore paths (multiple files in same dir). handleTrack() ignores the returned TrackResult (no behavior change). Files: cli.ts (lines 524-721).
