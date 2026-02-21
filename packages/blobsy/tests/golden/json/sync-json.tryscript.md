---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
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
  "schema_version": "1",
  "action": "sync",
  "files": [
    {
      "path": "data/dataset.csv",
      "action": "pushed",
      "size": 12,
      "remote_key": "[REMOTE_KEY]"
    },
    {
      "path": "data/model.bin",
      "action": "pushed",
      "size": 13,
      "remote_key": "[REMOTE_KEY]"
    }
  ],
  "summary": {
    "total": 2,
    "pushed": 2,
    "pulled": 0,
    "up_to_date": 0,
    "conflicts": 0,
    "failed": 0
  }
}
? 0
```

# sync --json: all up to date

```console
$ git add -A && git commit -q -m "push"
$ blobsy sync --json
{
  "schema_version": "1",
  "action": "sync",
  "files": [
    {
      "path": "data/dataset.csv",
      "action": "up_to_date",
      "size": 12
    },
    {
      "path": "data/model.bin",
      "action": "up_to_date",
      "size": 13
    }
  ],
  "summary": {
    "total": 2,
    "pushed": 0,
    "pulled": 0,
    "up_to_date": 2,
    "conflicts": 0,
    "failed": 0
  }
}
? 0
```
