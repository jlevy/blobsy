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
---
# push --json

```console
$ blobsy push --json
...
? 0
```

# pull --json after deleting local files

```console
$ git add -A && git commit -q -m "push"
? 0
```

```console
$ rm data/model.bin data/dataset.csv
? 0
```

```console
$ blobsy pull --json
...
? 0
```

# push --json when already synced

```console
$ blobsy push --json
...
? 0
```
