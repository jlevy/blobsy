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
# push --json

```console
$ blobsy push --json
{
  "schema_version": "1",
  "action": "push",
  "files": [
    {
      "path": "data/dataset.csv",
      "status": "pushed",
      "size": 12,
      "remote_key": "[REMOTE_KEY]"
    },
    {
      "path": "data/model.bin",
      "status": "pushed",
      "size": 13,
      "remote_key": "[REMOTE_KEY]"
    }
  ],
  "summary": {
    "total": 2,
    "pushed": 2,
    "already_synced": 0,
    "failed": 0
  }
}
? 0
```

# pull --json (after deleting local files)

```console
$ git add -A && git commit -q -m "push"
$ rm data/model.bin data/dataset.csv
$ blobsy pull --json
{
  "schema_version": "1",
  "action": "pull",
  "files": [
    {
      "path": "data/dataset.csv",
      "status": "pulled",
      "size": 12
    },
    {
      "path": "data/model.bin",
      "status": "pulled",
      "size": 13
    }
  ],
  "summary": {
    "total": 2,
    "pulled": 2,
    "already_up_to_date": 0,
    "failed": 0
  }
}
? 0
```

# push --json when already synced

```console
$ blobsy push --json
{
  "schema_version": "1",
  "action": "push",
  "files": [
    {
      "path": "data/dataset.csv",
      "status": "already_synced",
      "size": 12,
      "remote_key": "[REMOTE_KEY]"
    },
    {
      "path": "data/model.bin",
      "status": "already_synced",
      "size": 13,
      "remote_key": "[REMOTE_KEY]"
    }
  ],
  "summary": {
    "total": 2,
    "pushed": 0,
    "already_synced": 2,
    "failed": 0
  }
}
? 0
```
