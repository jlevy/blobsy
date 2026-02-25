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
  git add -A && git commit -q -m "track and push"
---
# Hooks missing -- doctor reports warnings

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

# Doctor --fix installs missing hooks

```console
$ blobsy doctor --fix
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ✓ Fixed  Installed pre-commit hook
  ✓ Fixed  Installed pre-push hook

All issues fixed.
? 0
```

# Verify hooks are installed and executable

```console
$ test -x .git/hooks/pre-commit && echo "pre-commit ok"
pre-commit ok
? 0
```

```console
$ test -x .git/hooks/pre-push && echo "pre-push ok"
pre-push ok
? 0
```

# Doctor is clean after hook install

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

No issues found.
? 0
```

# Non-blobsy hook detected

```console
$ printf '#!/bin/sh\necho "custom hook"\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
? 0
```

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook exists but is not a blobsy hook

1 issue found. Run with --fix to attempt repairs.
? 0
```

# Doctor --fix does not overwrite non-blobsy hook

```console
$ blobsy doctor --fix
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook exists but is not a blobsy hook

1 issue found.
? 0
```

# Non-blobsy hook content preserved

```console
$ grep "custom hook" .git/hooks/pre-commit
echo "custom hook"
? 0
```
