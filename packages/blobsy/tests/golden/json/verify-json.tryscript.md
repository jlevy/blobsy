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
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# verify --json: all ok

```console
$ blobsy verify --json
...
? 0
```

# verify --json: mismatch and missing file

```console
$ echo "corrupted" > data/model.bin
? 0
```

```console
$ rm data/weights.bin
? 0
```

```console
$ blobsy verify --json
...
? 1
```
