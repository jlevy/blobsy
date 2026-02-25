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
  git add -A && git commit -q -m "track"
---
# Verbose track shows extra detail

```console
$ echo "updated" > data/model.bin
? 0
```

```console
$ blobsy track --verbose data/model.bin
Updated data/model.bin.bref (hash changed)

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

# Verbose push shows extra detail

```console
$ blobsy push --verbose
  ↑  data/model.bin (8 B)
Done: 1 pushed.
? 0
```

# Verbose status shows extra detail

```console
$ blobsy status --verbose
  ✓  data/model.bin  synced (8 B)

1 tracked file: 1 synced
? 0
```
