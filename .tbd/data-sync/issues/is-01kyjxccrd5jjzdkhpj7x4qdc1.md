---
type: is
id: is-01kyjxccrd5jjzdkhpj7x4qdc1
title: "LIB-01: gitignore negation reaches all depths (!dir/**/)"
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:26.253Z
updated_at: 2026-07-27T23:08:26.253Z
---
gitignore.ts:275-278: emit !${negationBase}**/ per the comment; golden: .bref two levels below previously-ignored dir is committable.
