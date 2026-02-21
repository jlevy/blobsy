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
  cp small-file.txt data/weights.bin
  blobsy track data/model.bin
  blobsy track data/weights.bin
  git add -A && git commit -q -m "track files"
---
# Verify when all files match

```console
$ blobsy verify
  ✓  data/model.bin  ok
  ✓  data/weights.bin  ok

All files verified.
? 0
```

# Verify with a modified file

```console
$ echo "corrupted" > data/model.bin
? 0
```

```console
$ blobsy verify
  ✗  data/model.bin  mismatch
  ✓  data/weights.bin  ok

Verification failed.
? 1
```

# Verify with a missing file too

```console
$ rm data/weights.bin
? 0
```

```console
$ blobsy verify
  ✗  data/model.bin  mismatch
  ✗  data/weights.bin  missing

Verification failed.
? 1
```

# Verify a single file (restore model.bin first)

```console
$ echo "hello blobsy" > data/model.bin
? 0
```

```console
$ blobsy verify data/model.bin
  ✓  data/model.bin  ok

All files verified.
? 0
```

# Verify via .yref path (equivalent) after tampering

```console
$ echo "tampered" > data/model.bin
? 0
```

```console
$ blobsy verify data/model.bin.yref
  ✗  data/model.bin  mismatch

Verification failed.
? 1
```
