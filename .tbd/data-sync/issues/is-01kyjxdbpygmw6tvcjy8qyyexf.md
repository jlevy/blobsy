---
type: is
id: is-01kyjxdbpygmw6tvcjy8qyyexf
title: "SEC-01: reject __proto__/constructor/prototype config key segments"
kind: bug
status: closed
priority: 2
version: 2
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
parent_id: is-01kyjxad4kcjtwg6d00fe9cvcc
created_at: 2026-07-27T23:08:57.950Z
updated_at: 2026-07-28T00:35:14.409Z
closed_at: 2026-07-28T00:35:14.408Z
close_reason: Landed in P2 hardening commit
---
cli.ts get/setNestedValue, config.ts unsetNestedValue: reject dangerous segments; validate keys against schema (with CFG-03); regression tests for all three segments. In-process pollution only (v2 corrected claim).
