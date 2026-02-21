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
---
# Track nonexistent file fails

```console
$ blobsy track nonexistent.bin 2>&1
Error: File not found: nonexistent.bin
? 1
```

# Untrack nonexistent file fails

```console
$ blobsy untrack nonexistent.bin 2>&1
Error: Not tracked: nonexistent.bin (no .yref file found)
? 1
```

# rm nonexistent file fails

```console
$ blobsy rm nonexistent.bin 2>&1
Error: Not tracked: nonexistent.bin (no .yref file found)
? 1
```

# init without args fails

```console
$ blobsy init 2>&1
...
? 1
```

# init with unrecognized scheme fails

```console
$ blobsy init r2://bucket/prefix/ 2>&1
Error: Unrecognized backend URL scheme: r2:
...
? 1
```
