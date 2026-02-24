---
type: is
id: is-01kj4sj3a3g1k5dc200w8bjtr1
title: "Phase 7c: Add --unset flag and docs for config enhancements"
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies: []
parent_id: is-01kj4rxcpa005gf4t6ekvxjvfv
created_at: 2026-02-23T08:23:54.946Z
updated_at: 2026-02-24T17:31:29.746Z
closed_at: 2026-02-24T17:31:29.745Z
close_reason: "Phase 7c implemented: --unset flag on config"
---
Add --unset option. Implement unsetNestedValue() helper: delete nested key by dot-notation path, return boolean (false if key not found). Idempotent: non-existent key prints nothing, exits 0. Respects --global (unset from ~/.blobsy.yml) or repo config. Golden tests: config.tryscript.md --unset scenarios. Unit tests: config.test.ts for unsetNestedValue, resolveConfigWithOrigins, getTargetConfigPath. Docs: README, SKILL.md, CHANGELOG, design doc, help.tryscript.md.
