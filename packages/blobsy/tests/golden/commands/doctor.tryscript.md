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
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push model"
---
# Doctor on healthy repo

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

# Break things: clear the gitignore

```console
$ echo "" > data/.gitignore
? 0
```

# Doctor detects missing gitignore entry

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

# Doctor --fix repairs the issue

```console
$ blobsy doctor --fix
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ✓ Fixed  Installed pre-commit hook
  ✓ Fixed  Installed pre-push hook

=== INTEGRITY ===
  ✓ Fixed  data/model.bin: added missing .gitignore entry

All issues fixed.
? 0
```

# Verify gitignore was restored

```console
$ grep model.bin data/.gitignore
model.bin
? 0
```

# Verify fix worked - doctor is clean

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

No issues found.
? 0
```

# Doctor detects orphaned .bref (local file missing, no remote_key)

Create orphan: track a file without pushing, then remove the local file so .bref exists
but has no remote_key.

```console
$ cp small-file.txt data/orphan.bin && blobsy track data/orphan.bin && rm data/orphan.bin
Tracking data/orphan.bin
Created data/orphan.bin.bref
Added data/orphan.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)
  ?  data/orphan.bin  file missing (13 B)

2 tracked files: 1 synced, 1 missing_file

=== INTEGRITY ===
  ✗  data/orphan.bin: .bref exists but local file missing and no remote_key

1 issue found. Run with --fix to attempt repairs.
? 1
```

# Restore the file for clean state

```console
$ echo "hello blobsy" > data/orphan.bin
? 0
```

# Doctor detects missing .blobsy directory

```console
$ rm -rf .blobsy
? 0
```

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)
  ○  data/orphan.bin  not pushed (13 B)

2 tracked files: 1 synced, 1 new

=== INTEGRITY ===
  ✗  .blobsy/ directory missing

1 issue found. Run with --fix to attempt repairs.
? 1
```

```console
$ blobsy doctor --fix
  ✓  data/model.bin  synced (13 B)
  ○  data/orphan.bin  not pushed (13 B)

2 tracked files: 1 synced, 1 new

=== INTEGRITY ===
  ✓ Fixed  Created .blobsy/ directory

All issues fixed.
? 0
```

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)
  ○  data/orphan.bin  not pushed (13 B)

2 tracked files: 1 synced, 1 new

No issues found.
? 0
```
