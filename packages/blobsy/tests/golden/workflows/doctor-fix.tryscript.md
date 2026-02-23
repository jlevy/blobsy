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
  git add -A && git commit -q -m "track model"
  blobsy push
  git add -A && git commit -q -m "push model"
---
# Doctor on healthy repo -- no issues

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

2 issues found. Run with --fix to attempt repairs.
? 0
```

# Break: remove the gitignore entry

```console
$ echo "" > data/.gitignore
? 0
```

# Doctor detects the missing gitignore entry

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== INTEGRITY ===
  ✗  data/model.bin: missing from .gitignore

3 issues found. Run with --fix to attempt repairs.
? 1
```

# Fix it

```console
$ blobsy doctor --fix
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== INTEGRITY ===
  ✓ Fixed  data/model.bin: added missing .gitignore entry

2 issues found.
? 0
```

# Verify the fix -- gitignore restored

```console
$ grep model.bin data/.gitignore
model.bin
? 0
```

# Doctor is clean after fix

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

2 issues found. Run with --fix to attempt repairs.
? 0
```
