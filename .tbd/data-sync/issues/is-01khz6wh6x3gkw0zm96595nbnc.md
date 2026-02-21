---
type: is
id: is-01khz6wh6x3gkw0zm96595nbnc
title: "V2: Add directory move support to blobsy mv"
kind: task
status: open
priority: 3
version: 1
labels: []
dependencies: []
created_at: 2026-02-21T04:21:21.756Z
updated_at: 2026-02-21T04:21:21.756Z
---
Add recursive directory move support to 'blobsy mv'. Would be implemented on top of the V1 file move implementation. When moving a directory, recursively move all tracked files within it, updating all .yref files and .gitignore entries accordingly.
