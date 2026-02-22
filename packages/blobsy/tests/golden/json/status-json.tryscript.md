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
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# status --json: fully synced files

```console
$ blobsy status --json
{
  "schema_version": "0.1",
  "files": [
    {
      "path": "data/dataset.csv",
      "state": "synced",
      "details": "synced"
    },
    {
      "path": "data/model.bin",
      "state": "synced",
      "details": "synced"
    }
  ],
  "summary": {
    "total": 2
  }
}
? 0
```

# status --json: with modified file

```console
$ echo "modified" > data/model.bin
? 0
```

```console
$ blobsy status --json
{
  "schema_version": "0.1",
  "files": [
    {
      "path": "data/dataset.csv",
      "state": "synced",
      "details": "synced"
    },
    {
      "path": "data/model.bin",
      "state": "modified",
      "details": "modified"
    }
  ],
  "summary": {
    "total": 2
  }
}
? 0
```

# status --json: empty repo (no tracked files)

```console
$ rm data/model.bin.bref data/dataset.csv.bref
? 0
```

```console
$ blobsy status --json
{
  "schema_version": "0.1",
  "files": [],
  "summary": {
    "total": 0
  }
}
? 0
```
