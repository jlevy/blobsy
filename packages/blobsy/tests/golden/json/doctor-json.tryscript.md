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
# doctor --json: healthy repo

```console
$ blobsy doctor --json
...
? 0
```

# doctor --json: with issues

```console
$ echo "" > data/.gitignore
? 0
```

```console
$ blobsy doctor --json
...
? 1
```
