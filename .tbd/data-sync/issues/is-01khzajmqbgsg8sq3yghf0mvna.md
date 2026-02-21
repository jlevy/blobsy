---
type: is
id: is-01khzajmqbgsg8sq3yghf0mvna
title: "Clarify sync semantics: committed vs working-tree refs"
kind: task
status: closed
priority: 1
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T05:25:51.978Z
updated_at: 2026-02-21T05:42:01.152Z
closed_at: 2026-02-21T05:42:01.151Z
close_reason: "Removed incorrect 'Key Invariant' section (lines 2376-2382) that contradicted the actual design. The design is consistent: sync operates on working tree, can handle uncommitted refs (with warnings), and modifies .yref files (updates hash when files change, sets remote_key after push)."
---
**Source:** Round 6 reviews (GPT 5.3 Codex finding #1, GPT 5 Pro §4.3)

**Problem:** The main design doc contradicts itself:
- Some sections: `push/sync` can operate on uncommitted refs with warnings
- Other sections: `blobsy sync only operates on files whose .yref is committed to git`

**Conflict detection doc:** The sync algorithm (lines 374-482) reads from working-tree .yref files but doesn't clarify which model it follows.

**Needed:** Explicitly state the invariant:
1. **Working-tree semantics** (more ergonomic) - default
2. **Committed-only semantics** - opt-in via `--require-committed` flag for CI

**GPT 5 Pro recommendation:**
> Pick one and align: docs, CLI behavior, exit codes, JSON output schema
> Suggestion: default working-tree semantics, `--require-clean` / `--require-committed` for CI

**Impact:** Affects error messages, CLI behavior, and user mental model

**Files:**
- docs/project/design/current/conflict-detection-and-resolution.md
- docs/project/design/current/blobsy-design-v2.md
