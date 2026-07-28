---
type: is
id: is-01kyjxdb16ej1hr1jbf52c0xyf
title: "CLI batch: CLI-03 awaited doctor calls, CLI-04 mv dest checks + EXDEV, CLI-05 rm requires .bref, CLI-06 sync error printing"
kind: bug
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:57.254Z
updated_at: 2026-07-28T02:00:33.483Z
closed_at: 2026-07-28T02:00:33.479Z
close_reason: CLI-03 (awaited doctor fixes), CLI-05 (rm requires .bref), CLI-06 (sync error printing) done earlier; CLI-04 (mv dest-exists refusal + --force + EXDEV copy fallback, dry-run parity) done in 2e051fe.
---
commands-stage2.ts:1202,1424 await void'd calls; cli.ts:1599-1674 mv refuse existing dest/.bref + copy+unlink on EXDEV; cli.ts:1398-1411 rm --local requires .bref before unlink; commands-stage2.ts:491-493 print failed modified-file pushes.
