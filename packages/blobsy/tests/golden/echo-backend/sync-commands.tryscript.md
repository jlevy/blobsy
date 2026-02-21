---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
  - ../fixtures/echo-backend.ts
  - source: ../fixtures/echo-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data .mock-remote
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Sync pushes both files -- echo-backend.ts shows exact commands

```console
$ blobsy sync
PUSH [CWD]/[..] -> test-bucket/[REMOTE_KEY]
PUSH [CWD]/[..] -> test-bucket/[REMOTE_KEY]
Syncing 2 tracked files...
  ◑ data/dataset.csv (12 B) - pushed
  ◑ data/model.bin (13 B) - pushed
Done: 2 pushed, 0 pulled.
[..]
? 0
```

# Verify both blobs in mock remote

```console
$ find .mock-remote/ -type f | sort
.mock-remote/[REMOTE_KEY]
.mock-remote/[REMOTE_KEY]
? 0
```

# Delete one file, sync pulls it back -- echo-backend.ts shows pull command

```console
$ git add -A && git commit -q -m "push files"
$ rm data/model.bin
$ blobsy sync
PULL test-bucket/[REMOTE_KEY] -> [CWD]/[..]
Syncing 2 tracked files...
  ✓ data/dataset.csv (up to date)
  data/model.bin (13 B) - pulled
Done: 0 pushed, 1 pulled.
? 0
```
