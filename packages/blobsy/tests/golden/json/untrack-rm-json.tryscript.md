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
  cp small-file.txt data/backup.bin
  blobsy track data/model.bin
  blobsy track data/backup.bin
  git add -A && git commit -q -m "track"
---
# untrack --json

```console
$ blobsy untrack --json data/model.bin
{
  "schema_version": "0.1",
  "message": "Untracked data/model.bin",
  "level": "info"
}
? 0
```

# rm --json

```console
$ blobsy rm --json data/backup.bin
{
  "schema_version": "0.1",
  "message": "Removed data/backup.bin",
  "level": "info"
}
? 0
```
