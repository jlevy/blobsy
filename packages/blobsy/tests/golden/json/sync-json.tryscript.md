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
# sync --json: pushes both files

```console
$ blobsy sync --json
{
  "schema_version": "0.1",
  "sync": {
    "pushed": 2,
    "pulled": 0,
    "errors": 0,
    "total": 2
  }
}
? 0
```

# sync --json: all up to date

```console
$ git add -A && git commit -q -m "push"
? 0
```

```console
$ blobsy sync --json
{
  "schema_version": "0.1",
  "sync": {
    "pushed": 0,
    "pulled": 0,
    "errors": 0,
    "total": 2
  }
}
? 0
```
