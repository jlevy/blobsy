---
type: is
id: is-01khz6hxbxgngfg82mxeydrsr3
title: Document command backend cross-platform limitations
kind: task
status: closed
priority: 2
version: 3
labels: []
dependencies:
  - type: blocks
    target: is-01khz60h5643s942z2ptd6x3sq
created_at: 2026-02-21T04:15:33.756Z
updated_at: 2026-02-21T04:41:44.368Z
closed_at: 2026-02-21T04:41:44.366Z
close_reason: Documented command backend cross-platform limitations
---
Add documentation to blobsy-design-v2.md clarifying that command backends should avoid complex shell pipes/operators for cross-platform compatibility, or recommend using named tools (aws-cli, rclone) for mixed OS environments. Node's child_process handles shell execution differently on Windows (cmd.exe) vs Unix (/bin/sh).
