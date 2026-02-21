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
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push model"
---
# Doctor on healthy repo

```console
$ blobsy doctor
No issues found.
? 0
```

# Break things: clear the gitignore

```console
$ echo "" > data/.gitignore
? 0
```

# Doctor detects missing gitignore entry

```console
$ blobsy doctor
...
? 1
```

# Doctor --fix repairs the issue

```console
$ blobsy doctor --fix
...
? 0
```

# Verify fix worked - doctor is clean

```console
$ blobsy doctor
No issues found.
? 0
```
