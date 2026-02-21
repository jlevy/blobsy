---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
---
# Pre-push check fails when blobs are missing

```console
$ blobsy pre-push-check 2>&1
✗ 1 .yref file in HEAD has no remote blob:
  data/model.bin.yref (remote_key not set)

Run 'blobsy push' to upload missing blobs before pushing.
? 1
```

# Push the blob, then pre-push check passes

```console
$ blobsy push
[..]
$ git add -A && git commit -q -m "push model"
$ blobsy pre-push-check
✓ All committed .yref files have remote blobs
  Checked 1 .yref file in HEAD
? 0
```
