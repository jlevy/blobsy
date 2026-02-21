---
sandbox: true
---
# Skill brief output

```console
$ blobsy skill --brief
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

# Skill full output starts with markdown header

```console
$ blobsy skill | head -5
# blobsy

Git-native large file storage CLI.
Track large files with .yref pointer files in Git while storing blobs in S3, local
directories, or custom command backends.
? 0
```
