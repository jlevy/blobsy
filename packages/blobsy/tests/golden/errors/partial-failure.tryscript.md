---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
  cp small-file.txt data/good-file.bin
  cp another-file.txt data/bad-file.bin
  blobsy track data/good-file.bin
  blobsy track data/bad-file.bin
  git add -A && git commit -q -m "track"
---
# Push first file successfully

```console
$ blobsy push data/good-file.bin
Pushing 1 file...
  ◑ data/good-file.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

# Make remote unwritable, then push second file fails

```console
$ chmod 000 ../remote
$ blobsy push data/bad-file.bin 2>&1
Pushing 1 file...
  ✗ data/bad-file.bin (12 B) - FAILED

Error: Failed to push data/bad-file.bin (12 B)
[..]
1 file failed.
? 1
```

# Restore permissions

```console
$ chmod 755 ../remote
? 0
```

# Push all: one succeeds (already synced), one now succeeds

```console
$ blobsy push
Pushing 2 files...
  ◑ data/bad-file.bin (12 B) - pushed
  ◑ data/good-file.bin (13 B) - already synced
Done: 1 pushed, 1 already synced.
? 0
```
