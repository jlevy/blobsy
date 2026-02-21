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
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# doctor --json: healthy repo

```console
$ blobsy doctor --json
{
  "schema_version": "1",
  "configuration": {
    "backend": "local",
    "backend_details": {
      "type": "local",
      "path": "./remote"
    }
  },
  "repository": {
    "path": "[CWD]",
    "branch": "[..]",
    "tracked_files": 1,
    "total_size": 13
  },
  "stat_cache": {
    "entries": 1,
    "stale": 0
  },
  "checks": {
    "yref_valid": true,
    "format_versions_supported": true,
    "no_orphaned_gitignore": true,
    "no_missing_gitignore": true
  },
  "issues": [],
  "warnings": []
}
? 0
```

# doctor --json: with issues

```console
$ echo "" > data/.gitignore
$ blobsy doctor --json
{
  "schema_version": "1",
  "configuration": {
    "backend": "local",
    "backend_details": {
      "type": "local",
      "path": "./remote"
    }
  },
  "repository": {
    "path": "[CWD]",
    "branch": "[..]",
    "tracked_files": 1,
    "total_size": 13
  },
  "stat_cache": {
    "entries": 1,
    "stale": 0
  },
  "checks": {
    "yref_valid": true,
    "format_versions_supported": true,
    "no_orphaned_gitignore": true,
    "no_missing_gitignore": false
  },
  "issues": [
    {
      "type": "missing_gitignore",
      "yref": "data/model.bin.yref",
      "file": "data/model.bin",
      "message": "data/model.bin not in .gitignore"
    }
  ],
  "warnings": []
}
? 1
```
