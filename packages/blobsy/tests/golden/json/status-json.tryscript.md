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
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# status --json: fully synced file

```console
$ blobsy status --json
{
  "schema_version": "1",
  "files": [
    {
      "path": "data/model.bin",
      "state": "synced",
      "committed": true,
      "synced": true,
      "size": 13,
      "hash": "[HASH]",
      "remote_key": "[REMOTE_KEY]"
    }
  ],
  "summary": {
    "total": 1,
    "synced": 1,
    "needs_push": 0,
    "needs_commit": 0,
    "modified": 0,
    "missing": 0
  }
}
? 0
```

# status --json: multiple states

```console
$ blobsy track data/dataset.csv
[..]
$ echo "modified" > data/model.bin
$ blobsy status --json
{
  "schema_version": "1",
  "files": [
    {
      "path": "data/dataset.csv",
      "state": "unsynced",
      "committed": false,
      "synced": false,
      "size": 12,
      "hash": "[HASH]",
      "remote_key": null
    },
    {
      "path": "data/model.bin",
      "state": "modified",
      "committed": true,
      "synced": true,
      "size": 13,
      "hash": "[HASH]",
      "remote_key": "[REMOTE_KEY]"
    }
  ],
  "summary": {
    "total": 2,
    "synced": 0,
    "needs_push": 0,
    "needs_commit": 1,
    "modified": 1,
    "missing": 0
  }
}
? 0
```

# status --json: empty repo

```console
$ rm data/model.bin.yref data/dataset.csv.yref
$ blobsy status --json
{
  "schema_version": "1",
  "files": [],
  "summary": {
    "total": 0,
    "synced": 0,
    "needs_push": 0,
    "needs_commit": 0,
    "modified": 0,
    "missing": 0
  }
}
? 0
```
