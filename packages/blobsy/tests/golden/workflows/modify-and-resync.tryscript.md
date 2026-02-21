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
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Start: verify synced

```console
$ blobsy status
...
? 0
```

# Modify the file

```console
$ echo "updated model content!!" > data/model.bin
? 0
```

# Re-track to update hash

```console
$ blobsy track data/model.bin
[..]
? 0
```

# Verify ref updated

```console
$ cat data/model.bin.yref
...
? 0
```

# Push the new version

```console
$ blobsy push
...
? 0
```

# Remote now has blobs (content-addressable)

```console
$ test -n "$(find "$BLOBSY_TEST_REMOTE" -type f)"
? 0
```

# Commit and verify

```console
$ git add -A && git commit -q -m "update model"
? 0
```

```console
$ blobsy verify
...
All files verified.
? 0
```

# Status is fully synced again

```console
$ blobsy status
...
? 0
```
