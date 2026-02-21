---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
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
Verifying 2 tracked files...
  data/model.bin     ok (sha256 matches)
  data/weights.bin   ok (sha256 matches)
2 ok, 0 mismatch, 0 missing.
? 0
```

# Verify with a modified file

```console
$ echo "corrupted" > data/model.bin
$ blobsy verify
Verifying 2 tracked files...
  data/model.bin     MISMATCH (expected [SHORT_HASH]..., got [SHORT_HASH]...)
  data/weights.bin   ok (sha256 matches)
1 ok, 1 mismatch, 0 missing.
? 1
```

# Verify with a missing file

```console
$ rm data/weights.bin
$ blobsy verify
Verifying 2 tracked files...
  data/model.bin     MISMATCH (expected [SHORT_HASH]..., got [SHORT_HASH]...)
  data/weights.bin   MISSING
0 ok, 1 mismatch, 1 missing.
? 1
```

# Verify a single file

```console
$ echo "hello blobsy" > data/model.bin
$ blobsy verify data/model.bin
Verifying 1 tracked file...
  data/model.bin   ok (sha256 matches)
1 ok, 0 mismatch, 0 missing.
? 0
```

# Verify via .yref path (equivalent)

```console
$ blobsy verify data/model.bin.yref
Verifying 1 tracked file...
  data/model.bin   ok (sha256 matches)
1 ok, 0 mismatch, 0 missing.
? 0
```
