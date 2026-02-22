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
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
---
# Pre-push check fails when blobs are missing

```console
$ blobsy pre-push-check
  data/model.bin  missing remote blob

1 file missing remote blobs.
Run blobsy push first.
? 1
```

# Push the blob, then pre-push check passes

```console
$ blobsy push
  data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

# Verify push set remote_key

```console
$ grep remote_key data/model.bin.bref
remote_key: [REMOTE_KEY]
? 0
```

```console
$ blobsy pre-push-check
All refs have remote blobs. Safe to push.
? 0
```
