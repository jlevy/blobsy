---
type: is
id: is-01kj4sj35f6px3h07hd4tqycrp
title: "Phase 7b: Add --show-origin flag to blobsy config"
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels: []
dependencies: []
parent_id: is-01kj4rxcpa005gf4t6ekvxjvfv
created_at: 2026-02-23T08:23:54.797Z
updated_at: 2026-02-24T17:31:29.603Z
closed_at: 2026-02-24T17:31:29.600Z
close_reason: "Phase 7b implemented: --show-origin flag on config"
---
Add --show-origin option. Implement resolveConfigWithOrigins() in config.ts: returns ConfigOrigin[] with scope (builtin/global/repo) and file path for each level. For single key: walk origins in reverse, find first level with key, print 'scope\tfile\tvalue'. For all keys: list every effective key=value with origin. JSON mode: return array of {key, value, scope, file} in envelope. Tab-separated output matching git config format. Golden tests: config-show-origin.tryscript.md (new), config-json.tryscript.md updates.
