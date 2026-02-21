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
  mkdir -p data ../remote
  cp small-file.txt data/model.bin
  cp small-file.txt data/weights.bin
  blobsy track data/model.bin
  blobsy track data/weights.bin
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# verify --json: all ok

```console
$ blobsy verify --json
{
  "schema_version": "1",
  "files": [
    {
      "path": "data/model.bin",
      "status": "ok",
      "hash": "[HASH]",
      "size": 13
    },
    {
      "path": "data/weights.bin",
      "status": "ok",
      "hash": "[HASH]",
      "size": 13
    }
  ],
  "summary": {
    "total": 2,
    "ok": 2,
    "mismatch": 0,
    "missing": 0
  }
}
? 0
```

# verify --json: mismatch and missing

```console
$ echo "corrupted" > data/model.bin
$ rm data/weights.bin
$ blobsy verify --json
{
  "schema_version": "1",
  "files": [
    {
      "path": "data/model.bin",
      "status": "mismatch",
      "expected_hash": "[HASH]",
      "actual_hash": "[HASH]",
      "size": 13
    },
    {
      "path": "data/weights.bin",
      "status": "missing",
      "expected_hash": "[HASH]",
      "size": 13
    }
  ],
  "summary": {
    "total": 2,
    "ok": 0,
    "mismatch": 1,
    "missing": 1
  }
}
? 1
```
