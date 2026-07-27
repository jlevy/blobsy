---
type: is
id: is-01kyjxbgjc5jdypy5afemzjen9
title: "DS-01: Implement three-way sync (stat-cache merge base); sync must pull updates"
kind: bug
status: open
priority: 0
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies:
  - type: blocks
    target: is-01kyjxcd320rmd4vxsydxyqymw
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:07:57.388Z
updated_at: 2026-07-27T23:09:11.821Z
---
handleSync per decision table blobsy-stat-cache-design.md:376-453: local==base && ref!=base -> pull; local!=base && ref==base -> push; both differ -> conflict exit 2 with push/pull guidance; no base && local!=ref -> ambiguity error. Also pull when ref changed and local exists (not only when missing). Golden: two-user desync scenario.
