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
  blobsy push
  git add -A && git commit -q -m "push"
---
# doctor --json: healthy repo

```console
$ blobsy doctor --json
{
  "schema_version": "0.1",
  "issues": [],
  "summary": {
    "total": 0,
    "fixed": 0,
    "unfixed": 0
  }
}
? 0
```

# doctor --json: with issues

```console
$ echo "" > data/.gitignore
? 0
```

```console
$ blobsy doctor --json
{
  "schema_version": "0.1",
  "issues": [
    {
      "type": "gitignore",
      "message": "data/model.bin: missing from .gitignore",
      "fixed": false
    }
  ],
  "summary": {
    "total": 1,
    "fixed": 0,
    "unfixed": 1
  }
}
? 1
```
