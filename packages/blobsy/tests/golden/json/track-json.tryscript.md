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
---
# track --json single file

```console
$ blobsy track --json data/model.bin
{
  "schema_version": "0.1",
  "message": "Tracking data/model.bin",
  "level": "info"
}
? 0
```

# track --json directory

```console
$ blobsy track --json data/
? 0
```
