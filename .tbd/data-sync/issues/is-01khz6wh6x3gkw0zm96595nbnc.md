---
type: is
id: is-01khz6wh6x3gkw0zm96595nbnc
title: "V2: Add directory move support to blobsy mv"
kind: task
status: closed
priority: 3
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T04:21:21.756Z
updated_at: 2026-02-21T20:58:32.753Z
closed_at: 2026-02-21T20:58:32.752Z
close_reason: "Implemented directory move support for blobsy mv. Refactored handleMv into three functions: handleMv (entry point), handleMvDirectory (recursive directory move), and mvSingleFile (single file move). Directory moves find all .yref files in the source directory and move each file individually, mapping relative paths to the destination. Updated CLI description and argument help. Golden tests added and passing (22 mv tests total, 334 golden tests + 142 unit tests)."
---
Add recursive directory move support to 'blobsy mv'. Would be implemented on top of the V1 file move implementation. When moving a directory, recursively move all tracked files within it, updating all .yref files and .gitignore entries accordingly.
