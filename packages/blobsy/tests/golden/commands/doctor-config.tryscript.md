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
  mkdir -p remote .blobsy
---
# No config file

```console
$ rm .blobsy.yml
? 0
```

```console
$ blobsy doctor
No tracked files found.

=== CONFIGURATION ===
  ✗  No .blobsy.yml found

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== BACKEND ===
  ✗  Health check failed: No backends configured. Run: blobsy setup --auto <url>

4 issues found. Run with --fix to attempt repairs.
? 1
```

# Config missing backends key

```console
$ echo "something: wrong" > .blobsy.yml
? 0
```

```console
$ blobsy doctor
No tracked files found.

=== CONFIGURATION ===
  ✗  Backend resolution failed: No backends configured. Run: blobsy setup --auto <url>

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

=== BACKEND ===
  ✗  Health check failed: No backends configured. Run: blobsy setup --auto <url>

4 issues found. Run with --fix to attempt repairs.
? 1
```

# Invalid externalize.min_size and compress.algorithm

```console
$ printf 'backends:\n  default:\n    url: local:remote\nexternalize:\n  min_size: invalid\ncompress:\n  algorithm: lz4\n' > .blobsy.yml
? 0
```

```console
$ blobsy doctor
No tracked files found.

=== CONFIGURATION ===
  ⚠  externalize.min_size invalid: Invalid size format: invalid (expected e.g. "1mb", "100kb")
  ⚠  Unknown compression algorithm: lz4

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

4 issues found. Run with --fix to attempt repairs.
? 0
```

# Restore valid config

```console
$ printf 'backends:\n  default:\n    url: local:remote\n' > .blobsy.yml
? 0
```

```console
$ blobsy doctor
No tracked files found.

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

2 issues found. Run with --fix to attempt repairs.
? 0
```
