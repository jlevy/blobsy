---
type: is
id: is-01kyjxdac6cmrc7m6638rr31ms
title: "LIB-02: gitignore managed-block marker robustness"
kind: bug
status: open
priority: 2
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:56.582Z
updated_at: 2026-07-27T23:08:56.582Z
---
gitignore.ts:55-76,90-100: pair markers (END searched from START); unpaired -> warn + append fresh block; never absorb user lines outside well-formed block. Tests with damaged/conflicted markers.
