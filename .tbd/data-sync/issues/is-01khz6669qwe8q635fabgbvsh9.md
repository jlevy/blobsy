---
type: is
id: is-01khz6669qwe8q635fabgbvsh9
title: "Implement atomic downloads: temp file with hash verification, then rename into place"
kind: task
status: closed
priority: 1
version: 3
labels: []
dependencies: []
created_at: 2026-02-21T04:09:09.685Z
updated_at: 2026-02-21T05:19:32.311Z
closed_at: 2026-02-21T05:19:32.310Z
close_reason: "Already documented: atomic downloads section at line 1961"
---
## Context

The round 6 design reviews highlighted that atomic downloads are critical for data integrity, especially for interrupted transfers. While the built-in SDK can handle this, custom `command` backends (curl, scp, etc.) may stream directly to the final location, risking corruption on interrupt.

## Pattern Requirements

Implement atomic download pattern for all backends:

1. **Download to temp file**: Always download to a blobsy-managed temporary file (not the final destination)
2. **Hash verification**: Compute SHA-256 and verify integrity before moving to final location  
3. **Atomic rename**: Only rename temp file to final location after successful verification
4. **Command backend support**: For `command` backends, provide `$BLOBSY_TEMP_OUT` environment variable so user templates write to temp location; blobsy performs atomic rename on exit code 0

## Benefits

- **Consistent behavior** regardless of transfer engine (SDK vs command)
- **Integrity checks** before clobbering existing files
- **Safer `--force` semantics** - only replaces files with verified content
- **Cross-platform reliability** - doesn't depend on external tool behavior

## References

- gpt5pro review section 4.6: "Atomicity and partial files"
- gemin31 review: "Atomic Writes & Transport Delegation"
- opus46 review section 1.3: Content hash integrity verification
