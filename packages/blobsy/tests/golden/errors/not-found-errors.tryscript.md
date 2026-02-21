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
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# Track nonexistent file fails

```console
$ blobsy track nonexistent.bin 2>&1
Error: File not found: nonexistent.bin

  Check the file path and try again.
? 1
```

# Push untracked file fails

```console
$ echo "content" > data/untracked.bin
? 0
```

```console
$ blobsy push data/untracked.bin 2>&1
Error: Cannot read .yref file: [LOCAL_PATH]/data/untracked.bin.yref: ENOENT: no such file or directory, open '[LOCAL_PATH]/data/untracked.bin.yref'
? 1
```

# Untrack nonexistent file fails

```console
$ blobsy untrack nonexistent.bin 2>&1
Error: Not tracked: nonexistent.bin (no .yref file found)
? 1
```
