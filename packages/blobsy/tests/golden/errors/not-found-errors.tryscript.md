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
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# Pull when remote blob has been deleted

```console
$ rm data/model.bin
$ rm -rf remote/*
$ blobsy pull data/model.bin 2>&1
Error: Failed to pull data/model.bin

Remote blob not found at key: [REMOTE_KEY]
Backend: local:../remote

The .yref file references a blob that doesn't exist in remote storage.
This usually means someone committed the .yref without pushing the blob.

To fix:
  If you have the correct file locally, run: blobsy push --force data/model.bin
  Or run: blobsy check-unpushed (to find all such files)
? 1
```

# Pull on file with no remote_key set

```console
$ echo "hello blobsy" > data/model.bin
$ blobsy track data/model.bin
[..]
$ rm data/model.bin
$ blobsy pull data/model.bin 2>&1
Error: Cannot pull data/model.bin: no remote_key set

This file has never been pushed. Run 'blobsy push data/model.bin' first.
? 1
```

# Status shows missing file clearly

```console
$ blobsy status
Tracked files (1):
  ? data/model.bin (file missing)

Summary:
  1 missing (?)

Actions needed:
  Run 'blobsy pull data/model.bin' or 'blobsy rm data/model.bin'
? 0
```
