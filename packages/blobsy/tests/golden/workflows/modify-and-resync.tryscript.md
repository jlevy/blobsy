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
  blobsy push
  git add -A && git commit -q -m "push model"
---
# Start: fully synced

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# Modify the file

```console
$ echo "updated model weights v2" > data/model.bin
$ blobsy status
Tracked files (1):
  ~ data/model.bin (modified locally)

Summary:
  1 modified (~)

Actions needed:
  Run 'blobsy track data/model.bin' to update modified file
? 0
```

# Re-track to update hash

```console
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
$ cat data/model.bin.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: [HASH]
size: 25
remote_key: [REMOTE_KEY]
? 0
```

# Push the new version

```console
$ blobsy push data/model.bin
Warning: Operating on 1 uncommitted .yref file:
  data/model.bin.yref (modified)

Pushing 1 file...
  ◑ data/model.bin (25 B) - pushed
Done: 1 pushed.

Reminder: Run 'git add -A && git commit' to commit these refs.
? 0
```

# Remote now has both old and new blobs (content-addressable, no overwrite)

```console
$ find ../remote/ -type f | sort
../remote/[REMOTE_KEY]
../remote/[REMOTE_KEY]
? 0
```

# Commit and verify

```console
$ git add -A && git commit -q -m "update model v2"
$ blobsy verify
Verifying 1 tracked file...
  data/model.bin   ok (sha256 matches)
1 ok, 0 mismatch, 0 missing.
? 0
```

# Status is fully synced again

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```
