---
sandbox: true
---
# Prime brief output

```console
$ blobsy prime --brief
blobsy: Git-native large file storage CLI.
Track large files with .yref pointers in Git, store blobs in S3/local/custom backends.

Commands: init, track, push, pull, sync, status, verify, untrack, rm, mv, config, health, doctor
Global flags: --json, --quiet, --verbose, --dry-run

Quick start:
  blobsy init s3://bucket/prefix/
  blobsy track <file>
  blobsy push
  blobsy pull
? 0
```

# Prime full output starts with context header

```console
$ blobsy prime | head -5
# blobsy context

## What is blobsy?

A standalone CLI for storing large files outside Git while tracking them with
? 0
```
