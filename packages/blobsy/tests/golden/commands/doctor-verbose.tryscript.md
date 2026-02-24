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
  echo ".blobsy/" >> .gitignore
  git add -A && git commit -q -m "init"
  mkdir -p remote data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  blobsy hooks install
  git add -A && git commit -q -m "track and push"
  export BLOBSY_HOME=/tmp/test-no-global-config
---
# Verbose shows all passing checks

```console
$ BLOBSY_HOME=/tmp/test-no-global-config blobsy doctor --verbose
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== CONFIGURATION ===
  ✓  .blobsy.yml valid
  ✓  Global config: not present
  ✓  Backend: local:remote (local)

=== GIT HOOKS ===
  ✓  pre-commit hook installed
  ✓  pre-push hook installed

=== INTEGRITY ===

=== BACKEND ===
  ✓  Backend reachable and writable

No issues found.
? 0
```

# Non-verbose hides passing sections

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

No issues found.
? 0
```
