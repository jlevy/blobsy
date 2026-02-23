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
# Corrupt .bref file doesn’t crash doctor

```console
$ printf "not valid yaml: [" > data/model.bin.bref
? 0
```

```console
$ blobsy doctor
  ?  data/model.bin  invalid .bref

1 tracked file: 1 corrupt_bref

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== INTEGRITY ===
  ✗  data/model.bin: invalid .bref file: Invalid .bref file format: model.bin.bref

3 issues found. Run with --fix to attempt repairs.
? 1
```

# Restore valid .bref

```console
$ git checkout -- data/model.bin.bref
? 0
```

# Healthy repo baseline

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

# Remove .blobsy/ from root .gitignore

```console
$ echo "" > .gitignore
? 0
```

```console
$ blobsy doctor
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== INTEGRITY ===
  ✗  .blobsy/ not in root .gitignore

3 issues found. Run with --fix to attempt repairs.
? 1
```

# Doctor --fix adds .blobsy/ to root .gitignore

```console
$ blobsy doctor --fix
  ✓  data/model.bin  synced (13 B)

1 tracked file: 1 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== INTEGRITY ===
  ✓ Fixed  Added .blobsy/ to root .gitignore

2 issues found.
? 0
```

```console
$ grep '.blobsy' .gitignore
.blobsy/
? 0
```
