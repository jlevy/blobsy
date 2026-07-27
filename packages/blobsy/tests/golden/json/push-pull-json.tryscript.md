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
---
# push --json

```console
$ blobsy push --json
{
  "schema_version": "0.1",
  "pushed": [
    {
      "path": "data/dataset.csv",
      "success": true,
      "action": "push",
      "bytesTransferred": 21,
      "refUpdates": {
        "remote_key": "[REMOTE_KEY]",
        "compressed": "zstd",
        "compressed_size": 21
      }
    },
    {
      "path": "data/model.bin",
      "success": true,
      "action": "push",
      "bytesTransferred": 13,
      "refUpdates": {
        "remote_key": "[REMOTE_KEY]"
      }
    }
  ],
  "summary": {
    "total": 2,
    "succeeded": 2,
    "failed": 0
  }
}
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
{
  "schema_version": "0.1",
  "pulled": [
    {
      "path": "data/dataset.csv",
      "success": true,
      "action": "pull",
      "bytesTransferred": 12
    },
    {
      "path": "data/model.bin",
      "success": true,
      "action": "pull",
      "bytesTransferred": 13
    }
  ],
  "summary": {
    "total": 2,
    "succeeded": 2,
    "failed": 0
  }
}
? 0
```

# push --json when already synced

```console
$ blobsy push --json
{
  "schema_version": "0.1",
  "pushed": [],
  "summary": {
    "total": 0,
    "succeeded": 0,
    "failed": 0
  }
}
? 0
```
