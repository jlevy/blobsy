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
  "status": {
    "files": [
      {
        "path": "data/model.bin",
        "state": "synced",
        "details": "synced",
        "size": 13
      }
    ]
  },
  "issues": [
    {
      "type": "hooks",
      "severity": "warning",
      "message": "pre-commit hook not installed",
      "fixed": false,
      "fixable": true
    },
    {
      "type": "hooks",
      "severity": "warning",
      "message": "pre-push hook not installed",
      "fixed": false,
      "fixable": true
    }
  ],
  "summary": {
    "total": 2,
    "errors": 0,
    "warnings": 2,
    "info": 0,
    "fixed": 0,
    "unfixed": 2
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
  "status": {
    "files": [
      {
        "path": "data/model.bin",
        "state": "synced",
        "details": "synced",
        "size": 13
      }
    ]
  },
  "issues": [
    {
      "type": "hooks",
      "severity": "warning",
      "message": "pre-commit hook not installed",
      "fixed": false,
      "fixable": true
    },
    {
      "type": "hooks",
      "severity": "warning",
      "message": "pre-push hook not installed",
      "fixed": false,
      "fixable": true
    },
    {
      "type": "gitignore",
      "severity": "error",
      "message": "data/model.bin: missing from .gitignore",
      "fixed": false,
      "fixable": true
    }
  ],
  "summary": {
    "total": 3,
    "errors": 1,
    "warnings": 2,
    "info": 0,
    "fixed": 0,
    "unfixed": 3
  }
}
? 1
```
