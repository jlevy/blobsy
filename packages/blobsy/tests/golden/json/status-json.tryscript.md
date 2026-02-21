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
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# status --json: fully synced files

```console
$ blobsy status --json
...
? 0
```

# status --json: with modified file

```console
$ echo "modified" > data/model.bin
? 0
```

```console
$ blobsy status --json
...
? 0
```

# status --json: empty repo (no tracked files)

```console
$ rm data/model.bin.yref data/dataset.csv.yref
? 0
```

```console
$ blobsy status --json
...
? 0
```
