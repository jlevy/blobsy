---
type: is
id: is-01kyjxdd4rgkt9cppqet4j39yh
title: "Command consolidation (CLI-07): 22 -> 14 public commands"
kind: feature
status: open
priority: 2
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:59.416Z
updated_at: 2026-07-27T23:08:59.416Z
---
Fold init->setup, track->add (track = add --no-stage), health/check-unpushed->doctor (pre-push-check as doctor --ci), readme/skill->docs. Per design-assessment table; update help, docs, skill text, goldens.
