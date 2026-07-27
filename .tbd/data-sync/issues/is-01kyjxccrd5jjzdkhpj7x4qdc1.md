---
type: is
id: is-01kyjxccrd5jjzdkhpj7x4qdc1
title: "LIB-01: gitignore negation reaches all depths (!dir/**/)"
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:26.253Z
updated_at: 2026-07-27T23:57:53.722Z
closed_at: 2026-07-27T23:57:53.722Z
close_reason: Landed in P1 gate batch commit; goldens no-hooks + config-defaults added; 286 unit tests green
---
gitignore.ts:275-278: emit !${negationBase}**/ per the comment; golden: .bref two levels below previously-ignored dir is committable.
