---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
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
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
---
# Push shows the exact backend command via echo-backend.ts

```console
$ blobsy push data/model.bin
PUSH [CWD]/[..] -> test-bucket/[REMOTE_KEY]
Pushed data/model.bin (13 B)
Updated data/model.bin.yref (remote_key set)
? 0
```

# Verify the blob landed in the mock remote

```console
$ find .mock-remote/ -type f | sort
.mock-remote/[REMOTE_KEY]
? 0
```

# Verify the content in the remote

```console
$ cat .mock-remote/[REMOTE_KEY]
hello blobsy
? 0
```

# Push again (already synced, no echo)

```console
$ blobsy push data/model.bin
Pushing 1 file...
  ◑ data/model.bin (13 B) - already synced
Done: 0 pushed, 1 already synced.
? 0
```

# Verify ref was updated with remote_key

```console
$ cat data/model.bin.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: [HASH]
size: 13
remote_key: [REMOTE_KEY]
? 0
```
