---
type: is
id: is-01kj4rw9j14aq74dkj2e73qw2h
title: "Phase 1: Empty default always list — remove hardcoded file patterns"
kind: task
status: open
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - polish
dependencies:
  - type: blocks
    target: is-01kj4rwfp5etf8n1js8k0t9rdp
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
created_at: 2026-02-23T08:12:00.448Z
updated_at: 2026-02-23T08:13:01.888Z
---
Change getBuiltinDefaults() always array from 11 patterns to []. Update config.test.ts, golden tests (externalization, track, config-json). Update README, SKILL.md, CHANGELOG, design doc.
