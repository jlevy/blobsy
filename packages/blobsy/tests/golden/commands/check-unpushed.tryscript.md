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
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Check-unpushed when blobs never pushed

```console
$ blobsy check-unpushed
  data/dataset.csv
  data/model.bin

2 files not pushed.
? 1
```

# Push one file, then check again

```console
$ blobsy push data/model.bin
  data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ blobsy check-unpushed
  data/dataset.csv

1 file not pushed.
? 1
```

# Push all, then check (all clear)

```console
$ blobsy push
  data/model.bin  already pushed
  data/dataset.csv (21 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ blobsy check-unpushed
All tracked files have been pushed.
? 0
```
