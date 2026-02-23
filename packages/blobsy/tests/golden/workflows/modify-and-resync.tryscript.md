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
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Start: verify synced

```console
$ blobsy status
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced
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
Updated data/model.bin.bref (hash changed)
? 0
```

# Verify ref updated with new hash

```console
$ grep hash data/model.bin.bref
hash: [HASH]
? 0
```

# Push the new version

```console
$ blobsy push
  ↑  data/model.bin (24 B)
Done: 1 pushed.
? 0
```

# Verify push updated the remote_key

```console
$ grep remote_key data/model.bin.bref
remote_key: [REMOTE_KEY]
? 0
```

# Commit and verify

```console
$ git add -A && git commit -q -m "update model"
? 0
```

```console
$ blobsy verify
  ✓  data/model.bin  ok

All files verified.
? 0
```

# Status is fully synced again

```console
$ blobsy status
  ✓  data/model.bin  synced (24 B)

1 tracked file: 1 synced
? 0
```
