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
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
---
# track --json nonexistent file

```console
$ blobsy track --json nonexistent.bin 2>&1
{
  "schema_version": "0.1",
  "error": "File not found: nonexistent.bin",
  "type": "validation",
  "suggestions": [
    "Check the file path and try again."
  ]
}
? 1
```

# push --json untracked file

```console
$ echo "content" > data/untracked.bin
? 0
```

```console
$ blobsy push --json data/untracked.bin 2>&1
{
  "schema_version": "0.1",
  "error": "Cannot read .yref file: [LOCAL_PATH]/data/untracked.bin.yref: ENOENT: no such file or directory, open '[LOCAL_PATH]/data/untracked.bin.yref'",
  "type": "validation"
}
? 1
```

# verify --json with modified file

```console
$ echo "tampered" > data/model.bin
? 0
```

```console
$ blobsy verify --json
{
  "schema_version": "0.1",
  "files": [
    {
      "path": "data/model.bin",
      "status": "mismatch",
      "expected": "[HASH]",
      "actual": "[HASH]"
    }
  ],
  "ok": false
}
? 1
```

# status --json with modified file

```console
$ blobsy status --json
{
  "schema_version": "0.1",
  "files": [
    {
      "path": "data/model.bin",
      "state": "modified",
      "details": "modified"
    }
  ],
  "summary": {
    "total": 1
  }
}
? 0
```
