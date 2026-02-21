---
type: is
id: is-01khz6wf5y5hqth1b0b8arc7tr
title: Implement blobsy mv command for files
kind: task
status: closed
priority: 1
version: 2
labels: []
dependencies: []
created_at: 2026-02-21T04:21:19.676Z
updated_at: 2026-02-21T05:18:37.752Z
closed_at: 2026-02-21T05:18:37.751Z
close_reason: "Already documented in spec: blobsy mv command for V1 at line 1111"
---
Add 'blobsy mv <source> <dest>' command for V1. Moves both payload file and .yref, updates .gitignore entries, preserves remote_key (no re-upload). Verifies source is tracked, dest doesn't exist. Only supports individual files in V1 (no directory moves). This fixes the P0 gap where git mv only moves .yref but not payload, causing constant drift.
